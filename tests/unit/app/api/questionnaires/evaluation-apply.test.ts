/**
 * Unit test: the design-evaluation apply engine (F5.3).
 *
 * Exercises the engine's decision branches with `prisma` and the fork seam mocked: the early
 * needs-authoring returns (prose-only / add_question), the stale + target_gone guards, the
 * happy in-place draft apply, and the fork-lineage convergence rule (a second apply from a run
 * that already forked reuses that draft instead of re-forking).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireEvaluationFinding: { findFirst: vi.fn(), update: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn(), update: vi.fn(), findUniqueOrThrow: vi.fn() },
  appQuestionSlot: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  appQuestionnaireSection: { count: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const forkMock = vi.hoisted(() => ({ forkVersionIfLaunched: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => forkMock);

import { applyFinding } from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import type { VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

type Mock = ReturnType<typeof vi.fn>;

const scoped = { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' as const };
const audit = { userId: 'admin-1', clientIp: null };

function structure(): VersionStructureInput {
  return {
    goal: 'Goal',
    audience: null,
    sections: [
      {
        title: 'S',
        questions: [{ key: 'q_role', prompt: 'Role?', type: 'free_text', required: true }],
      },
    ],
  };
}

function finding(
  over?: Partial<{ targetKey: string; proposedEdit: unknown; editedOverride: unknown }>
) {
  return {
    id: 'find-1',
    targetKey: 'q_role',
    proposedEdit: { op: 'replace_prompt', prompt: 'What is your role?' },
    editedOverride: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // No prior apply for this run by default (findRunReviewDraft → null).
  prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(null);
  // The transaction runner executes the callback with a tx proxy backed by the same mock.
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock)
  );
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
    versionId: 'v1',
    forked: false,
    versionNumber: 1,
  });
});

describe('applyFinding — early returns', () => {
  it('is needs_authoring for a prose-only finding (no op)', async () => {
    const res = await applyFinding({
      finding: finding({ proposedEdit: null }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res).toEqual({
      status: 'unapplicable',
      reason: 'needs_authoring',
      detail: expect.any(String),
    });
  });

  it('is needs_authoring for an add_question when the version has no sections to add into', async () => {
    // No sectionKey + a slot-keyed targetKey → no named section; an empty version can't host it.
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(0);
    const res = await applyFinding({
      finding: finding({ proposedEdit: { op: 'add_question', prompt: 'New?', type: 'free_text' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('needs_authoring');
  });

  it('is stale when the targeted prompt changed since the run', async () => {
    const current = structure();
    current.sections[0].questions[0].prompt = 'changed';
    const res = await applyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current,
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('stale');
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('is target_gone when the slot no longer resolves on the version', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null);
    const res = await applyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('target_gone');
  });
});

describe('applyFinding — happy path (draft, in place)', () => {
  it('writes the op and marks the finding applied, no fork', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });

    const res = await applyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(res).toEqual({
      status: 'applied',
      appliedToVersionId: 'v1',
      forked: false,
      versionNumber: 1,
    });
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slot-1' }, data: { prompt: 'What is your role?' } })
    );
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'find-1' },
        data: expect.objectContaining({ status: 'applied', appliedToVersionId: 'v1' }),
      })
    );
  });
});

describe('applyFinding — each op writes the right thing', () => {
  beforeEach(() => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
  });

  it('edit_guidelines writes the guidelines field', async () => {
    await applyFinding({
      finding: finding({ proposedEdit: { op: 'edit_guidelines', guidelines: 'Be specific.' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { guidelines: 'Be specific.' } })
    );
  });

  it('change_type (config-optional type) writes the new type', async () => {
    const res = await applyFinding({
      finding: finding({ proposedEdit: { op: 'change_type', type: 'numeric' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('applied');
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'numeric' }) })
    );
  });

  it('change_type to a config-required type with no config → op_invalid (no write)', async () => {
    const res = await applyFinding({
      finding: finding({ proposedEdit: { op: 'change_type', type: 'single_choice' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('op_invalid');
    expect(prismaMock.appQuestionSlot.update).not.toHaveBeenCalled();
    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
  });

  it('delete_question deletes the slot', async () => {
    await applyFinding({
      finding: finding({ proposedEdit: { op: 'delete_question' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.appQuestionSlot.delete).toHaveBeenCalledWith({ where: { id: 'slot-1' } });
  });

  it('reorder with a target section moves + reslots', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-2' });
    await applyFinding({
      finding: finding({
        proposedEdit: { op: 'reorder', ordinal: 2, targetSectionKey: 'Other' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ordinal: 2, section: { connect: { id: 'sec-2' } } }),
      })
    );
  });

  it('reorder with an ambiguous target section → op_invalid', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(2);
    const res = await applyFinding({
      finding: finding({ proposedEdit: { op: 'reorder', ordinal: 0, targetSectionKey: 'Dup' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('op_invalid');
  });

  it('reorder with a missing target section → target_gone', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(0);
    const res = await applyFinding({
      finding: finding({ proposedEdit: { op: 'reorder', ordinal: 0, targetSectionKey: 'Gone' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('target_gone');
  });

  it('edit_goal updates the version goal (no slot lookup)', async () => {
    prismaMock.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      goal: 'Goal',
      goalProvenance: null,
    });
    const res = await applyFinding({
      finding: finding({
        targetKey: 'goal',
        proposedEdit: { op: 'edit_goal', goal: 'Sharper goal' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('applied');
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ goal: 'Sharper goal' }) })
    );
  });

  it('edit_audience merge-patches the version audience', async () => {
    prismaMock.appQuestionnaireVersion.findUniqueOrThrow.mockResolvedValue({
      audience: { role: 'old' },
      audienceProvenance: null,
    });
    await applyFinding({
      finding: finding({
        targetKey: 'audience',
        proposedEdit: { op: 'edit_audience', audience: { role: 'manager' } },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.appQuestionnaireVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ audience: expect.objectContaining({ role: 'manager' }) }),
      })
    );
  });
});

describe('applyFinding — add_question', () => {
  beforeEach(() => {
    // A section to host the new question, no existing slots in it (key derivation + ordinal).
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(1);
    prismaMock.appQuestionnaireSection.findFirst.mockResolvedValue({ id: 'sec-1' });
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([]);
    prismaMock.appQuestionSlot.count.mockResolvedValue(0);
  });

  it('creates the drafted question in the named section and marks the finding applied', async () => {
    const res = await applyFinding({
      finding: finding({
        targetKey: 'section:Background',
        proposedEdit: {
          op: 'add_question',
          prompt: 'How big is your team?',
          type: 'free_text',
          sectionKey: 'Background',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(res.status).toBe('applied');
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: 'How big is your team?',
          type: 'free_text',
          sectionId: 'sec-1',
          versionId: 'v1',
        }),
      })
    );
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'find-1' },
        data: expect.objectContaining({ status: 'applied', appliedToVersionId: 'v1' }),
      })
    );
  });

  it('honors the judge-proposed key (slugified + collision-suffixed)', async () => {
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'work_morale' }]);
    await applyFinding({
      finding: finding({
        targetKey: 'section:Background',
        proposedEdit: {
          op: 'add_question',
          prompt: 'How would you describe your current morale at work?',
          type: 'free_text',
          key: 'Work Morale',
          sectionKey: 'Background',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    // 'Work Morale' → slug 'work_morale', already taken → '_2'; never the whole-prompt slug.
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ key: 'work_morale_2' }) })
    );
  });

  it('defaults the typeConfig for a choice type the judge drafted without options', async () => {
    const res = await applyFinding({
      finding: finding({
        targetKey: 'section:Background',
        proposedEdit: {
          op: 'add_question',
          prompt: 'Pick one',
          type: 'single_choice',
          sectionKey: 'Background',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(res.status).toBe('applied');
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'single_choice',
          typeConfig: expect.objectContaining({ choices: expect.any(Array) }),
        }),
      })
    );
  });

  it('is target_gone when the named section no longer resolves', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(0);
    const res = await applyFinding({
      finding: finding({
        targetKey: 'section:Gone',
        proposedEdit: {
          op: 'add_question',
          prompt: 'x',
          type: 'free_text',
          sectionKey: 'Gone',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('target_gone');
    expect(prismaMock.appQuestionSlot.create).not.toHaveBeenCalled();
  });

  it('is op_invalid when the named section title is ambiguous', async () => {
    prismaMock.appQuestionnaireSection.count.mockResolvedValue(2);
    const res = await applyFinding({
      finding: finding({
        targetKey: 'section:Dup',
        proposedEdit: {
          op: 'add_question',
          prompt: 'x',
          type: 'free_text',
          sectionKey: 'Dup',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('op_invalid');
  });
});

describe('applyFinding — fork-lineage convergence', () => {
  it('reuses an existing review draft instead of forking again', async () => {
    // findRunReviewDraft: a prior apply from this run targeted draft v2.
    prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({ id: 'v2', versionNumber: 2 });
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-on-v2' });

    const res = await applyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped, // the run's version is still the launched original
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(forkVersionIfLaunched).not.toHaveBeenCalled();
    expect(res).toEqual({
      status: 'applied',
      appliedToVersionId: 'v2',
      forked: false,
      versionNumber: 2,
    });
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slot-on-v2' } })
    );
  });
});

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
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  appQuestionnaireSection: { count: vi.fn(), findFirst: vi.fn() },
  appQuestionnaireTopic: { findMany: vi.fn(), updateMany: vi.fn() },
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
  // No topics by default — the overwhelmingly common shape, and the one that must stay a no-op.
  prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);
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

describe('applyFinding — split_question', () => {
  const SPLIT = {
    op: 'split_question' as const,
    prompt: 'Who is the designated safeguarding lead this year?',
    secondPrompt: 'When did they last complete advanced training?',
    secondKey: 'lead_last_advanced_training',
  };

  beforeEach(() => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
    prismaMock.appQuestionSlot.findUniqueOrThrow.mockResolvedValue({
      sectionId: 'sec-1',
      ordinal: 2,
      type: 'free_text',
      typeConfig: { commentAggregation: 'isolated' },
      required: true,
      weight: 0.75,
      fidelity: 1,
      guidelines: 'Name the person and the date.',
    });
    prismaMock.appQuestionSlot.findMany.mockResolvedValue([
      { key: 'q_role' },
      { key: 'lead_last_advanced_training' },
    ]);
  });

  async function applySplit() {
    return applyFinding({
      finding: finding({ proposedEdit: SPLIT }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
  }

  // The load-bearing property. Rewriting BOTH halves as new slots would orphan every answer already
  // mapped to this question; keeping the target's id means nothing that referenced it stops
  // resolving, and the second half is purely additive.
  it('keeps the target slot and gives it the first half', async () => {
    const res = await applySplit();

    expect(res.status).toBe('applied');
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith({
      where: { id: 'slot-1' },
      data: { prompt: SPLIT.prompt },
    });
    expect(prismaMock.appQuestionSlot.delete).not.toHaveBeenCalled();
  });

  // Adjacency is part of the contract: two halves separated by six unrelated questions read worse
  // than the compound they replaced, which is why `add_question`'s append-to-end is not reused.
  it('inserts the second half directly after the target, shifting its siblings down', async () => {
    await applySplit();

    expect(prismaMock.appQuestionSlot.updateMany).toHaveBeenCalledWith({
      where: { sectionId: 'sec-1', ordinal: { gt: 2 } },
      data: { ordinal: { increment: 1 } },
    });
    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sectionId: 'sec-1',
          ordinal: 3,
          prompt: SPLIT.secondPrompt,
        }),
      })
    );
  });

  // A compound question's two halves almost always want the same answer type, and an author who set
  // `required`, a weight or a fidelity stop meant it for both asks — defaulting them would silently
  // drop authored intent on one half.
  it('inherits the target settings rather than defaulting them', async () => {
    await applySplit();

    expect(prismaMock.appQuestionSlot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'free_text',
          typeConfig: { commentAggregation: 'isolated' },
          required: true,
          weight: 0.75,
          fidelity: 1,
          guidelines: 'Name the person and the date.',
        }),
      })
    );
  });

  // `versionId_key` is unique, so a judge proposing a key that already exists must be disambiguated
  // rather than 409'd — a suggestion is never an admin-chosen explicit key.
  it('collision-suffixes a proposed key that is already taken', async () => {
    await applySplit();

    const created = prismaMock.appQuestionSlot.create.mock.calls[0][0] as {
      data: { key: string };
    };
    expect(created.data.key).not.toBe('lead_last_advanced_training');
    expect(created.data.key).toMatch(/^lead_last_advanced_training/);
  });

  it('marks the finding applied in the same transaction', async () => {
    await applySplit();

    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.appQuestionnaireEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'applied' }) })
    );
  });

  it('is unapplicable when the target question is gone', async () => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue(null);

    const res = await applySplit();

    expect(res.status).toBe('unapplicable');
    expect(prismaMock.appQuestionSlot.create).not.toHaveBeenCalled();
  });
});

describe('applyFinding — which version, and whose op', () => {
  beforeEach(() => {
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
  });

  // `resolveEffectiveOp` is documented as "the admin's edited override wins over the judge's
  // draft", and every fixture in this file left `editedOverride` null — so the precedence itself
  // was never exercised. Inverting it would be invisible: the judge's original op would be applied
  // while the UI showed the admin's edit, which is a silent write of something nobody approved.
  it('applies the admin edited override in preference to the judge draft', async () => {
    await applyFinding({
      finding: finding({
        proposedEdit: { op: 'replace_prompt', prompt: 'The judge wording' },
        editedOverride: { op: 'replace_prompt', prompt: 'The admin wording' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { prompt: 'The admin wording' } })
    );
  });

  // Every other test in this file mocks the fork as a no-op returning the SAME version id, so the
  // launched path — where the write must be retargeted onto a brand-new draft — never ran. Getting
  // this wrong writes the edit straight into a launched version that respondents are answering.
  it('retargets the write onto the fork when the version was launched', async () => {
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });
    prismaMock.appQuestionSlot.findFirst
      // The pre-fork validation lookup, against the launched original…
      .mockResolvedValueOnce({ id: 'slot-1' })
      // …then the retarget lookup, against the new draft. Distinct ids so the assertion can tell
      // which one the write used.
      .mockResolvedValueOnce({ id: 'slot-on-v2' });

    const res = await applyFinding({
      finding: finding(),
      runId: 'run-1',
      scoped: { ...scoped, status: 'launched' as const },
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(res).toMatchObject({ status: 'applied', forked: true, appliedToVersionId: 'v2' });
    expect(prismaMock.appQuestionSlot.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ versionId: 'v2' }) })
    );
    expect(prismaMock.appQuestionSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slot-on-v2' } })
    );
  });
});

/**
 * Topic membership (Conditional Topics, F17.35).
 *
 * With Conditional Topics on, a question belonging to no topic is never asked — `isQuestionInScope`
 * is `!scope.active || scope.questionKeys.has(key)` — and nothing in the runtime reports it. So the
 * apply engine has to keep membership true as it adds and removes questions.
 *
 * These are asserted at the `updateMany` boundary rather than through a round-trip, because the
 * choice of `updateMany` over `update` IS the behaviour under test: a concurrent Topics-tab save
 * (`replaceTopics` = deleteMany + createMany) can remove the row between the read and the write,
 * and a P2025 inside a Postgres transaction would poison it and roll back the question too.
 */
describe('applyFinding — topic membership', () => {
  const TOPICS = [
    {
      id: 'topic-open',
      key: 'opening',
      ordinal: 0,
      members: { questionKeys: ['q_role'], dataSlotKeys: ['slot_a'] },
    },
    {
      id: 'topic-depth',
      key: 'talent_depth',
      ordinal: 1,
      members: { questionKeys: ['q_role', 'q_other'], dataSlotKeys: [] },
    },
    {
      id: 'topic-untouched',
      key: 'closing',
      ordinal: 2,
      members: { questionKeys: ['q_wrap'], dataSlotKeys: [] },
    },
  ];

  interface TopicUpdate {
    where: { id: string };
    data: { members: { questionKeys: string[]; dataSlotKeys: string[] } };
  }

  function topicUpdates(): TopicUpdate[] {
    return (prismaMock.appQuestionnaireTopic.updateMany as Mock).mock.calls.map(
      (c: unknown[]) => c[0] as TopicUpdate
    );
  }

  describe('delete_question prunes the key', () => {
    beforeEach(() => {
      prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
      prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
    });

    it('removes the deleted key from every topic that claimed it, and no others', async () => {
      const res = await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      expect(res.status).toBe('applied');
      const updates = topicUpdates();
      expect(updates).toHaveLength(2);
      expect(updates.map((u) => u.where.id)).toEqual(['topic-open', 'topic-depth']);
      // The untouched topic never claimed q_role, so it is never written — that skip is what the
      // helpers' same-identity return exists to make possible.
      expect(updates.map((u) => u.where.id)).not.toContain('topic-untouched');
    });

    it('leaves the emptied topic in place, present and empty', async () => {
      // An empty topic still carries a label, a phase and criteria an author wrote, and
      // `empty_topic` is the warning that says it now asks nothing. Pruning is what MAKES that
      // warning fire; deleting the topic would destroy the work and the warning together.
      await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      const opening = topicUpdates().find((u) => u.where.id === 'topic-open');
      expect(opening?.data.members).toEqual({ questionKeys: [], dataSlotKeys: ['slot_a'] });
      expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.anything() }) })
      );
    });

    it('keeps the data slots untouched while pruning the question key', async () => {
      await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      const opening = topicUpdates().find((u) => u.where.id === 'topic-open');
      expect(opening?.data.members).toMatchObject({ dataSlotKeys: ['slot_a'] });
    });

    it('never stamps source, so a seeded topic stays seeded', async () => {
      // `isEligibleForScopeCandidacy` and the launch readiness check both gate on
      // `source: { not: 'seeded' }`. Flipping it here would silently suppress the Routing Analyst
      // candidacy check for the version — and the admin approved a question change, not a topic one.
      await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      for (const update of topicUpdates()) {
        expect(update.data).not.toHaveProperty('source');
      }
    });

    it('writes nothing when the version has no topics', async () => {
      prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);

      const res = await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      expect(res.status).toBe('applied');
      expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
    });

    it('uses updateMany, so a row removed by a concurrent save is not a P2025', async () => {
      // `update` would throw, and a thrown query inside a Postgres transaction aborts it — the
      // finding stamp would then fail and the question deletion would roll back with it.
      await applyFinding({
        finding: finding({ proposedEdit: { op: 'delete_question' } }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });

      expect(prismaMock.appQuestionnaireTopic.updateMany).toHaveBeenCalled();
      expect(prismaMock.appQuestionnaireTopic).not.toHaveProperty('update.mock.calls.0');
    });
  });

  describe('split_question copies the parent’s membership', () => {
    const SPLIT = {
      op: 'split_question' as const,
      prompt: 'Who is the designated safeguarding lead?',
      secondPrompt: 'When did they last train?',
      secondKey: 'lead_last_training',
    };

    beforeEach(() => {
      prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-1' });
      prismaMock.appQuestionSlot.findUniqueOrThrow.mockResolvedValue({
        sectionId: 'sec-1',
        ordinal: 2,
        type: 'free_text',
        typeConfig: null,
        required: true,
        weight: 0.75,
        fidelity: 1,
        guidelines: null,
      });
      prismaMock.appQuestionSlot.findMany.mockResolvedValue([{ key: 'q_role' }]);
      prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);
    });

    async function applySplit() {
      return applyFinding({
        finding: finding({ proposedEdit: SPLIT }),
        runId: 'run-1',
        scoped,
        snapshot: structure(),
        current: structure(),
        audit,
      });
    }

    it('adds the new half to every topic the parent belonged to', async () => {
      // A split is one question reshaped, so whatever the original was part of, both halves are.
      const res = await applySplit();

      expect(res.status).toBe('applied');
      const updates = topicUpdates();
      expect(updates.map((u) => u.where.id)).toEqual(['topic-open', 'topic-depth']);
      expect(updates[0]?.data.members).toEqual({
        questionKeys: ['q_role', 'lead_last_training'],
        dataSlotKeys: ['slot_a'],
      });
      expect(updates[1]?.data.members).toEqual({
        questionKeys: ['q_role', 'q_other', 'lead_last_training'],
        dataSlotKeys: [],
      });
    });

    it('does not touch a topic the parent was never in', async () => {
      await applySplit();

      expect(topicUpdates().map((u) => u.where.id)).not.toContain('topic-untouched');
    });

    it('writes the collision-suffixed key, not the proposed one', async () => {
      // The second half's key goes through `nextAvailableKey`; membership must carry whatever that
      // produced, or the topic names a question that does not exist.
      prismaMock.appQuestionSlot.findMany.mockResolvedValue([
        { key: 'q_role' },
        { key: 'lead_last_training' },
      ]);

      await applySplit();

      const created = (prismaMock.appQuestionSlot.create as Mock).mock.calls[0][0].data.key;
      expect(created).not.toBe('lead_last_training');
      expect(topicUpdates()[0]?.data.members).toMatchObject({
        questionKeys: ['q_role', created],
      });
    });

    it('writes nothing when the version has no topics', async () => {
      prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue([]);

      const res = await applySplit();

      expect(res.status).toBe('applied');
      expect(prismaMock.appQuestionnaireTopic.updateMany).not.toHaveBeenCalled();
    });
  });

  it('reads and writes topics on the FORKED version, never the launched one', async () => {
    // `scoped.id` is in hand and is the natural thing to reach for — and writing there would mutate
    // a launched version's topic rows. Keys survive a fork 1:1, so the finding's targetKey is still
    // the right handle on the draft.
    (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
      versionId: 'v2',
      forked: true,
      versionNumber: 2,
    });
    prismaMock.appQuestionSlot.findFirst.mockResolvedValue({ id: 'slot-on-v2' });
    prismaMock.appQuestionnaireTopic.findMany.mockResolvedValue(TOPICS);

    await applyFinding({
      finding: finding({ proposedEdit: { op: 'delete_question' } }),
      runId: 'run-1',
      scoped: { ...scoped, status: 'launched' as const },
      snapshot: structure(),
      current: structure(),
      audit,
    });

    expect(prismaMock.appQuestionnaireTopic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId: 'v2' } })
    );
  });
});

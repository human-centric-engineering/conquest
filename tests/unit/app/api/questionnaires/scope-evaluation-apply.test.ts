/**
 * Unit test: the scope-evaluation apply engine (F17.21).
 *
 * Mirrors `evaluation-apply.test.ts` (F5.3): the early needs-authoring/stale/target_gone
 * guards, the happy in-place draft apply, each op writing the right thing, and the
 * fork-lineage convergence rule (a second apply from a run that already forked reuses that
 * draft). Also pins the three PR-gate fixes made to this file:
 *   - the write + finding-stamp go through one `prisma.$transaction`, not two separate writes
 *   - a topic-field write stamps `source: 'manual'` (an admin-approved apply is not an
 *     untouched auto-seed any more)
 *   - `loadAdaptiveScopeSettings` / `patchAdaptiveScopeSettings` are called with the
 *     transaction client, not the bare `prisma` singleton, so they participate in the
 *     transaction rather than escaping it
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireScopeEvaluationFinding: { findFirst: vi.fn(), update: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn() },
  appQuestionnaireTopic: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const forkMock = vi.hoisted(() => ({ forkVersionIfLaunched: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/fork', () => forkMock);

const topicRoutesMock = vi.hoisted(() => ({
  loadAdaptiveScopeSettings: vi.fn(),
  patchAdaptiveScopeSettings: vi.fn(),
}));
vi.mock('@/app/api/v1/app/questionnaires/_lib/topic-routes', () => topicRoutesMock);

import {
  applyScopeFinding,
  findRunReviewDraft,
} from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-apply';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  loadAdaptiveScopeSettings,
  patchAdaptiveScopeSettings,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import type { ScopeStructureInput } from '@/lib/app/questionnaire/scope-evaluation';

type Mock = ReturnType<typeof vi.fn>;

const scoped = { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' as const };
const audit = { userId: 'admin-1', clientIp: null };

function structure(): ScopeStructureInput {
  return {
    topics: [
      {
        key: 'talent',
        label: 'Talent & culture',
        phase: 'conditional',
        criteria: 'when relevant',
        depth: 'full',
        members: [],
      },
    ],
    rules: [
      {
        id: 'rule-1',
        sentence: 'x',
        dataSlotKey: 'engagement',
        topicKey: 'talent',
        operator: 'gt',
        action: 'include',
      },
    ],
    settings: {
      maxConditionalTopics: 3,
      includeCheckTopic: true,
      fallbackTopicKeys: [],
      minConfidence: 0.6,
      plannerInstructions: '',
      sessionBudgetSeconds: 600,
      limitOpeningProbes: false,
      maxOpeningProbes: 1,
    },
    costs: { budgetSeconds: 600, alwaysSeconds: 60, routedAllowanceSeconds: 540, perTopic: [] },
    knownIssues: [],
  };
}

/**
 * What `loadAdaptiveScopeSettings` actually returns (`AdaptiveScopeSettings`) — distinct from
 * `structure().settings` (`ScopeStructureInput`'s curated read-only slice), because only this
 * shape carries `rules`. The apply engine's rule ops (`add_rule`/`edit_rule`/`delete_rule`) read
 * `settings.rules` from THIS function, never from the structure DTO.
 */
function settingsFixture() {
  return {
    ...structure().settings,
    rules: [
      {
        id: 'rule-1',
        dataSlotKey: 'engagement',
        operator: 'gt' as const,
        value: '50',
        action: 'include' as const,
        topicKey: 'talent',
        ordinal: 0,
      },
    ],
  };
}

function finding(
  over?: Partial<{ targetKey: string; proposedEdit: unknown; editedOverride: unknown }>
) {
  return {
    id: 'find-1',
    targetKey: 'topic:talent',
    proposedEdit: { op: 'edit_topic_criteria', criteria: 'The respondent names a hiring problem.' },
    editedOverride: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // No prior apply for this run by default (findRunReviewDraft → null).
  prismaMock.appQuestionnaireScopeEvaluationFinding.findFirst.mockResolvedValue(null);
  // The transaction runner executes the callback with a tx proxy backed by the same mock.
  prismaMock.$transaction.mockImplementation(async (cb: (tx: typeof prismaMock) => unknown) =>
    cb(prismaMock)
  );
  (forkVersionIfLaunched as unknown as Mock).mockResolvedValue({
    versionId: 'v1',
    forked: false,
    versionNumber: 1,
  });
  (loadAdaptiveScopeSettings as unknown as Mock).mockResolvedValue(settingsFixture());
  (patchAdaptiveScopeSettings as unknown as Mock).mockResolvedValue(settingsFixture());
});

describe('applyScopeFinding — early returns', () => {
  it('is needs_authoring for a prose-only finding (no op)', async () => {
    const res = await applyScopeFinding({
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

  it('is stale when the targeted topic criteria changed since the run', async () => {
    const current = structure();
    current.topics[0].criteria = 'changed since the run';
    const res = await applyScopeFinding({
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

  it('is target_gone when the topic no longer exists on the version', async () => {
    prismaMock.appQuestionnaireTopic.findUnique.mockResolvedValue(null);
    const res = await applyScopeFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('unapplicable');
    if (res.status === 'unapplicable') expect(res.reason).toBe('target_gone');
    expect(prismaMock.appQuestionnaireTopic.update).not.toHaveBeenCalled();
  });

  it('is target_gone when an edit_rule/delete_rule targets a rule id no longer in settings', async () => {
    (loadAdaptiveScopeSettings as unknown as Mock).mockResolvedValue({
      ...structure().settings,
      rules: [],
    });
    const res = await applyScopeFinding({
      finding: finding({
        targetKey: 'rule:rule-1',
        proposedEdit: { op: 'delete_rule' },
      }),
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

describe('applyScopeFinding — happy path (draft, in place)', () => {
  beforeEach(() => {
    prismaMock.appQuestionnaireTopic.findUnique.mockResolvedValue({ id: 'topic-row-1' });
  });

  it('writes the op, stamps source: manual, and marks the finding applied, no fork', async () => {
    const res = await applyScopeFinding({
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
    expect(prismaMock.appQuestionnaireTopic.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { versionId_key: { versionId: 'v1', key: 'talent' } },
        data: { criteria: 'The respondent names a hiring problem.', source: 'manual' },
      })
    );
    expect(prismaMock.appQuestionnaireScopeEvaluationFinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'find-1' },
        data: expect.objectContaining({ status: 'applied', appliedToVersionId: 'v1' }),
      })
    );
  });

  it('runs the write and the finding stamp inside one transaction', async () => {
    await applyScopeFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it('skips the finding-stamp write when the op write itself reports unapplicable', async () => {
    // A race: the topic existed at validation time but the write call still fails.
    prismaMock.appQuestionnaireTopic.update.mockRejectedValueOnce(new Error('row gone'));
    const res = await applyScopeFinding({
      finding: finding(),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res).toEqual({ status: 'unapplicable', reason: 'target_gone' });
    expect(prismaMock.appQuestionnaireScopeEvaluationFinding.update).not.toHaveBeenCalled();
  });
});

describe('applyScopeFinding — each op writes the right thing', () => {
  beforeEach(() => {
    prismaMock.appQuestionnaireTopic.findUnique.mockResolvedValue({ id: 'topic-row-1' });
  });

  it('edit_topic_depth writes depth + stamps source: manual', async () => {
    await applyScopeFinding({
      finding: finding({ proposedEdit: { op: 'edit_topic_depth', depth: 'light' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(prismaMock.appQuestionnaireTopic.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { depth: 'light', source: 'manual' } })
    );
  });

  it('add_rule appends to the existing rules and calls patchAdaptiveScopeSettings with the tx client', async () => {
    const res = await applyScopeFinding({
      finding: finding({
        targetKey: 'settings',
        proposedEdit: {
          op: 'add_rule',
          dataSlotKey: 'headcount',
          operator: 'gt',
          value: '50',
          action: 'include',
          topicKey: 'talent',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('applied');
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({
        rules: expect.arrayContaining([expect.objectContaining({ dataSlotKey: 'headcount' })]),
      }),
      prismaMock
    );
  });

  it('delete_rule removes the matching rule', async () => {
    await applyScopeFinding({
      finding: finding({ targetKey: 'rule:rule-1', proposedEdit: { op: 'delete_rule' } }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith('v1', { rules: [] }, prismaMock);
  });

  it('edit_rule replaces the matching rule fields', async () => {
    await applyScopeFinding({
      finding: finding({
        targetKey: 'rule:rule-1',
        proposedEdit: {
          op: 'edit_rule',
          dataSlotKey: 'headcount',
          operator: 'lt',
          value: '10',
          action: 'exclude',
          topicKey: 'compliance',
        },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith(
      'v1',
      {
        rules: [
          expect.objectContaining({ id: 'rule-1', dataSlotKey: 'headcount', action: 'exclude' }),
        ],
      },
      prismaMock
    );
  });

  it('adjust_budget sends only the fields present on the op', async () => {
    await applyScopeFinding({
      finding: finding({
        targetKey: 'settings',
        proposedEdit: { op: 'adjust_budget', maxConditionalTopics: 5 },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith(
      'v1',
      { maxConditionalTopics: 5 },
      prismaMock
    );
  });

  it('edit_planner_instructions writes the full replacement text', async () => {
    await applyScopeFinding({
      finding: finding({
        targetKey: 'settings',
        proposedEdit: { op: 'edit_planner_instructions', plannerInstructions: 'Prefer breadth.' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith(
      'v1',
      { plannerInstructions: 'Prefer breadth.' },
      prismaMock
    );
  });

  it('add_fallback_topic appends the key', async () => {
    await applyScopeFinding({
      finding: finding({
        targetKey: 'settings',
        proposedEdit: { op: 'add_fallback_topic', topicKey: 'compliance' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(patchAdaptiveScopeSettings).toHaveBeenCalledWith(
      'v1',
      { fallbackTopicKeys: ['compliance'] },
      prismaMock
    );
  });

  it('add_fallback_topic is a no-op (still applied) when the key is already there', async () => {
    (loadAdaptiveScopeSettings as unknown as Mock).mockResolvedValue({
      ...structure().settings,
      fallbackTopicKeys: ['compliance'],
    });
    const res = await applyScopeFinding({
      finding: finding({
        targetKey: 'settings',
        proposedEdit: { op: 'add_fallback_topic', topicKey: 'compliance' },
      }),
      runId: 'run-1',
      scoped,
      snapshot: structure(),
      current: structure(),
      audit,
    });
    expect(res.status).toBe('applied');
    expect(patchAdaptiveScopeSettings).not.toHaveBeenCalled();
  });
});

describe('applyScopeFinding — fork-lineage convergence', () => {
  it('reuses an existing review draft instead of forking again', async () => {
    // findRunReviewDraft: a prior apply from this run targeted draft v2.
    prismaMock.appQuestionnaireScopeEvaluationFinding.findFirst.mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({ id: 'v2', versionNumber: 2 });
    prismaMock.appQuestionnaireTopic.findUnique.mockResolvedValue({ id: 'topic-on-v2' });

    const res = await applyScopeFinding({
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
    expect(prismaMock.appQuestionnaireTopic.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { versionId_key: { versionId: 'v2', key: 'talent' } } })
    );
  });
});

describe('findRunReviewDraft', () => {
  it('returns null when the run has no prior applied finding', async () => {
    prismaMock.appQuestionnaireScopeEvaluationFinding.findFirst.mockResolvedValue(null);
    expect(await findRunReviewDraft('run-1', 'qn-1')).toBeNull();
  });

  it('returns null when the previously-applied draft no longer exists as a draft', async () => {
    prismaMock.appQuestionnaireScopeEvaluationFinding.findFirst.mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
    expect(await findRunReviewDraft('run-1', 'qn-1')).toBeNull();
  });

  it('resolves the draft version when one exists', async () => {
    prismaMock.appQuestionnaireScopeEvaluationFinding.findFirst.mockResolvedValue({
      appliedToVersionId: 'v2',
    });
    prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({ id: 'v2', versionNumber: 2 });
    expect(await findRunReviewDraft('run-1', 'qn-1')).toEqual({ id: 'v2', versionNumber: 2 });
  });
});

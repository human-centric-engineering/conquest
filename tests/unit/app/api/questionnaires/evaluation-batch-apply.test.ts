/**
 * Unit test: the design-evaluation batch apply engine (F5.4).
 *
 * The engine is a loop around `applyFinding`, so the writing itself is covered by
 * `evaluation-apply.test.ts` and mocked out here. What this file pins is the three things
 * batching adds and the single-apply path could not have: the execution order, the live re-read
 * between findings, and the honest per-finding report.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  appQuestionnaireEvaluationFinding: { findMany: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));

const applyMock = vi.hoisted(() => ({ applyFinding: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-apply', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/api/v1/app/questionnaires/_lib/evaluation-apply')>();
  return { ...actual, applyFinding: applyMock.applyFinding };
});

const structureMock = vi.hoisted(() => ({ buildEvaluationStructure: vi.fn() }));
vi.mock('@/app/api/v1/app/questionnaires/_lib/evaluation-structure', () => structureMock);

import {
  applyAcceptedFindings,
  orderForApply,
  type BatchFindingRow,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-batch-apply';
import {
  applyFinding,
  type ApplyOutcome,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import type { ProposedEdit, VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

type Mock = ReturnType<typeof vi.fn>;

const scoped = { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' as const };
const audit = { userId: 'admin-1', clientIp: null };

function structure(): VersionStructureInput {
  return { goal: 'Goal', audience: null, sections: [] };
}

function row(
  over: Partial<BatchFindingRow> & { proposedEdit: ProposedEdit | null }
): BatchFindingRow {
  return {
    id: 'f1',
    targetKey: 'q_role',
    editedOverride: null,
    applyInstruction: null,
    dimension: 'clarity',
    ordinal: 0,
    ...over,
  };
}

/** `vi.mocked` rather than a bare cast: it keeps applyFinding's real signature, so the outcome
 *  shapes below are type-checked and an async implementation is the expected type rather than
 *  something smuggled past a void-returning `Mock`. */
const applyFindingMock = vi.mocked(applyFinding);

/** Every applyFinding call resolves as a plain in-place apply on `v1`. */
function applyLands() {
  applyFindingMock.mockResolvedValue({
    status: 'applied',
    appliedToVersionId: 'v1',
    forked: false,
    versionNumber: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (buildEvaluationStructure as unknown as Mock).mockResolvedValue(structure());
});

describe('orderForApply', () => {
  it('runs a delete after a reword of the same question', () => {
    // The case that decides the whole ranking. Two judges disagree, the reviewer accepts both in
    // the moment; deleting first makes the reword `target_gone`, rewording first makes the delete
    // a clean no-loss. Same end state, only one order reports it without an error.
    const ordered = orderForApply([
      row({ id: 'del', proposedEdit: { op: 'delete_question' }, dimension: 'a' }),
      row({
        id: 'word',
        proposedEdit: { op: 'replace_prompt', prompt: 'Better?' },
        dimension: 'z',
      }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['word', 'del']);
  });

  it('runs content edits before moves, and version-level edits before everything', () => {
    const ordered = orderForApply([
      row({ id: 'move', proposedEdit: { op: 'reorder', ordinal: 2 } }),
      row({ id: 'word', proposedEdit: { op: 'replace_prompt', prompt: 'Better?' } }),
      row({ id: 'goal', proposedEdit: { op: 'edit_goal', goal: 'Sharper' } }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['goal', 'word', 'move']);
  });

  it('is total, so the same accepted set always executes the same way', () => {
    // Equal rank, equal dimension, equal ordinal — without the id tiebreak the order would depend
    // on the row order the database happened to return, and two presses could differ.
    const rows = [
      row({ id: 'b', proposedEdit: { op: 'replace_prompt', prompt: 'B' } }),
      row({ id: 'a', proposedEdit: { op: 'replace_prompt', prompt: 'A' } }),
    ];
    expect(orderForApply(rows).map((r) => r.id)).toEqual(['a', 'b']);
    expect(orderForApply([...rows].reverse()).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not mutate the caller’s array', () => {
    const rows = [
      row({ id: 'del', proposedEdit: { op: 'delete_question' } }),
      row({ id: 'word', proposedEdit: { op: 'replace_prompt', prompt: 'x' } }),
    ];
    orderForApply(rows);
    expect(rows.map((r) => r.id)).toEqual(['del', 'word']);
  });
});

describe('applyAcceptedFindings', () => {
  it('re-reads the structure before each finding, so a later change is judged against earlier ones', async () => {
    // Without this, two judges rewording the same question both "succeed" and the second silently
    // overwrites the first — the staleness re-check inside applyFinding would be comparing against
    // a structure that predates the batch.
    applyLands();
    await applyAcceptedFindings({
      findings: [
        row({ id: 'f1', proposedEdit: { op: 'replace_prompt', prompt: 'One' } }),
        row({ id: 'f2', proposedEdit: { op: 'replace_prompt', prompt: 'Two' } }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });
    expect(buildEvaluationStructure).toHaveBeenCalledTimes(2);
  });

  it('re-reads from the fork once one has been made, not from the launched original', async () => {
    // The first apply forks; every later staleness check has to look at the draft being written,
    // or the batch judges its own work against a version it is no longer editing.
    applyFindingMock
      .mockResolvedValueOnce({
        status: 'applied',
        appliedToVersionId: 'v2',
        forked: true,
        versionNumber: 2,
      })
      .mockResolvedValueOnce({
        status: 'applied',
        appliedToVersionId: 'v2',
        forked: false,
        versionNumber: 2,
      });

    const result = await applyAcceptedFindings({
      findings: [
        row({ id: 'f1', proposedEdit: { op: 'replace_prompt', prompt: 'One' } }),
        row({ id: 'f2', proposedEdit: { op: 'edit_guidelines', guidelines: 'Two' } }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped: { ...scoped, status: 'launched' as const },
      snapshot: structure(),
      audit,
    });

    expect((buildEvaluationStructure as unknown as Mock).mock.calls).toEqual([
      ['qn-1', 'v1'],
      ['qn-1', 'v2'],
    ]);
    // And the batch reports the fork once, for the whole run.
    expect(result).toMatchObject({ versionId: 'v2', versionNumber: 2, forked: true });
  });

  it('reports every skipped finding with its reason instead of swallowing it', async () => {
    // A batch that quietly drops changes is worse than no batch: the reviewer believes eleven
    // things happened and eight did.
    // Keyed on the finding, not on call order: the engine deliberately reorders what it is given,
    // so a positional mock would be asserting the ordering rule twice and this behaviour zero times.
    const outcomes: Record<string, ApplyOutcome> = {
      ok: { status: 'applied', appliedToVersionId: 'v1', forked: false, versionNumber: 1 },
      drifted: { status: 'unapplicable', reason: 'stale' },
      prose: { status: 'unapplicable', reason: 'needs_authoring', detail: 'No structured edit' },
    };
    applyFindingMock.mockImplementation((args) => Promise.resolve(outcomes[args.finding.id]));

    const result = await applyAcceptedFindings({
      findings: [
        row({ id: 'ok', proposedEdit: { op: 'replace_prompt', prompt: 'One' } }),
        row({ id: 'drifted', proposedEdit: { op: 'change_type', type: 'likert' } }),
        row({ id: 'prose', proposedEdit: null }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(result.applied).toEqual([
      { findingId: 'ok', targetKey: 'q_role', op: 'replace_prompt' },
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { findingId: 'drifted', targetKey: 'q_role', reason: 'stale' },
        {
          findingId: 'prose',
          targetKey: 'q_role',
          reason: 'needs_authoring',
          detail: 'No structured edit',
        },
      ])
    );
    expect(result.skipped).toHaveLength(2);
  });

  it('defers a finding carrying the reviewer’s instruction rather than applying it without one', async () => {
    // Applying the judge's op and discarding the steer is the one outcome that must not happen:
    // the reviewer wrote "keep it under 15 words" and would be told it succeeded.
    applyLands();
    const result = await applyAcceptedFindings({
      findings: [
        row({
          id: 'steered',
          proposedEdit: { op: 'replace_prompt', prompt: 'Judge wording' },
          applyInstruction: 'Keep it under 15 words.',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(applyFinding).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ findingId: 'steered', reason: 'needs_ai' });
  });

  it('returns a result rather than an error when nothing could be applied', async () => {
    // "Every accepted change was already stale" is an answer to "apply my accepted changes", and
    // the reviewer needs the per-finding reasons to act on it.
    applyFindingMock.mockResolvedValue({
      status: 'unapplicable',
      reason: 'stale',
    });
    const result = await applyAcceptedFindings({
      findings: [row({ proposedEdit: { op: 'delete_question' } })],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.versionId).toBe('v1');
  });

  it('skips a finding whose structure could not be read, and carries on with the rest', async () => {
    applyLands();
    (buildEvaluationStructure as unknown as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(structure());

    const result = await applyAcceptedFindings({
      findings: [
        row({ id: 'first', proposedEdit: { op: 'replace_prompt', prompt: 'One' } }),
        row({ id: 'second', proposedEdit: { op: 'edit_guidelines', guidelines: 'Two' } }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(result.skipped).toEqual([
      { findingId: 'first', targetKey: 'q_role', reason: 'target_gone' },
    ]);
    expect(result.applied.map((a) => a.findingId)).toEqual(['second']);
  });
});

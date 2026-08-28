/**
 * Unit test: the design-evaluation batch apply engine (F5.4).
 *
 * The engine is a loop around `applyFinding`, so the writing itself is covered by
 * `evaluation-apply.test.ts` and mocked out here. What this file pins is the four things
 * batching adds and the single-apply path could not have: the execution order, the live re-read
 * between findings, the honest per-finding report, and the AI leg that turns a reviewer's
 * free-text steer into the change they actually accepted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  // `findFirst` + the version lookup back the REAL `findRunReviewDraft`, which the batch calls
  // before its first write to learn which version it is actually editing.
  appQuestionnaireEvaluationFinding: { findMany: vi.fn(), findFirst: vi.fn() },
  appQuestionnaireVersion: { findFirst: vi.fn() },
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

// The AI leg's single model call. Stubbed here for the same reason `applyFinding` is: this file is
// about what the batch does with a steer's outcome, not about the completion that produced it.
const steerMock = vi.hoisted(() => ({ steerProposedEdit: vi.fn() }));
vi.mock('@/lib/app/questionnaire/evaluation/steer-edit', () => steerMock);

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
import { steerProposedEdit } from '@/lib/app/questionnaire/evaluation/steer-edit';
import type { ProposedEdit, VersionStructureInput } from '@/lib/app/questionnaire/evaluation';

type Mock = ReturnType<typeof vi.fn>;

const scoped = { id: 'v1', questionnaireId: 'qn-1', versionNumber: 1, status: 'draft' as const };
const audit = { userId: 'admin-1', clientIp: null };

function structure(): VersionStructureInput {
  return {
    goal: 'Goal',
    audience: null,
    sections: [
      {
        title: 'About you',
        questions: [
          { key: 'q_role', prompt: 'What is your role?', type: 'free_text', required: true },
        ],
      },
    ],
  };
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
    proposedChange: 'Reword it.',
    rationale: 'It is ambiguous.',
    ...over,
  };
}

/** `vi.mocked` rather than a bare cast: it keeps applyFinding's real signature, so the outcome
 *  shapes below are type-checked and an async implementation is the expected type rather than
 *  something smuggled past a void-returning `Mock`. */
const applyFindingMock = vi.mocked(applyFinding);
const steerMockFn = vi.mocked(steerProposedEdit);

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
  // No prior apply from this run → no existing draft, so the batch starts at the run's version.
  prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue(null);
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue(null);
});

/** Model a run that a previous batch already forked to `versionId`. */
function runAlreadyEditingDraft(versionId: string, versionNumber: number) {
  prismaMock.appQuestionnaireEvaluationFinding.findFirst.mockResolvedValue({
    appliedToVersionId: versionId,
  });
  prismaMock.appQuestionnaireVersion.findFirst.mockResolvedValue({
    id: versionId,
    versionNumber,
  });
}

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

  it('makes no model call at all when nobody wrote an instruction', async () => {
    // The deterministic path has to stay exactly as cheap as it was: a run triaged without a single
    // steer must not read the structure an extra time, and must not reach a provider.
    applyLands();
    await applyAcceptedFindings({
      findings: [row({ proposedEdit: { op: 'replace_prompt', prompt: 'One' } })],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });
    expect(steerProposedEdit).not.toHaveBeenCalled();
    expect(buildEvaluationStructure).toHaveBeenCalledTimes(1);
  });
});

describe('applyAcceptedFindings — the reviewer’s steer', () => {
  it('applies the AI’s rewrite, not the judge’s wording, and says what it did', async () => {
    applyLands();
    steerMockFn.mockResolvedValue({
      ok: true,
      edit: { op: 'replace_prompt', prompt: 'Reviewer wording' },
      note: 'Shortened it to twelve words.',
      unhonoured: null,
    });

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

    // The rewrite rides in as an override, so it goes through the same validation an admin's typed
    // override does — the AI leg is a rewriter in front of apply, not a way past it.
    expect(applyFindingMock.mock.calls[0][0].finding.editedOverride).toEqual({
      op: 'replace_prompt',
      prompt: 'Reviewer wording',
    });
    expect(result.applied).toEqual([
      {
        findingId: 'steered',
        targetKey: 'q_role',
        op: 'replace_prompt',
        steer: { note: 'Shortened it to twelve words.', unhonoured: null },
      },
    ]);
  });

  it('hands the steer the question as it stands, not just the judge’s op', async () => {
    // A rewrite that cannot see the current wording is guessing at what it is changing.
    applyLands();
    steerMockFn.mockResolvedValue({
      ok: true,
      edit: { op: 'replace_prompt', prompt: 'Reviewer wording' },
      note: 'Done.',
      unhonoured: null,
    });

    await applyAcceptedFindings({
      findings: [
        row({
          proposedEdit: { op: 'replace_prompt', prompt: 'Judge wording' },
          applyInstruction: 'Plainer, please.',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(steerMockFn.mock.calls[0][0]).toMatchObject({
      instruction: 'Plainer, please.',
      question: { key: 'q_role', prompt: 'What is your role?' },
      goal: 'Goal',
    });
    expect(steerMockFn.mock.calls[0][1]).toMatchObject({ runId: 'run1', versionId: 'v1' });
  });

  it('carries an unhonoured part of the instruction through to the report', async () => {
    // A steer that only partly landed has to be visible at the moment it lands, or the reviewer
    // reads "applied" as "all of it applied".
    applyLands();
    steerMockFn.mockResolvedValue({
      ok: true,
      edit: { op: 'replace_prompt', prompt: 'Reviewer wording' },
      note: 'Shortened it.',
      unhonoured: 'Changing it to a 1–5 scale is not something wording can do.',
    });

    const result = await applyAcceptedFindings({
      findings: [
        row({
          proposedEdit: { op: 'replace_prompt', prompt: 'Judge wording' },
          applyInstruction: 'Shorter, and make it a 1–5 scale.',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(result.applied[0].steer?.unhonoured).toBe(
      'Changing it to a 1–5 scale is not something wording can do.'
    );
  });

  it('applies nothing for that finding when the rewrite fails — never the judge’s op instead', async () => {
    // The substitution this whole leg exists to avoid: the reviewer asked for their version of the
    // change, and quietly giving them a different one under the same button is worse than a skip.
    applyLands();
    steerMockFn.mockResolvedValue({
      ok: false,
      code: 'steer_failed',
      message: 'The AI could not rewrite this change.',
    });

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
    expect(result.skipped[0]).toMatchObject({
      findingId: 'steered',
      reason: 'needs_ai',
      detail: 'The AI could not rewrite this change.',
    });
  });

  it('reports an instruction attached to a change with no wording, without paying for a call', async () => {
    // `delete_question` has no prose for an instruction to shape. Applying it and dropping the
    // sentence would read as honoured; asking a model to reword a deletion is nonsense.
    applyLands();

    const result = await applyAcceptedFindings({
      findings: [
        row({
          id: 'gone',
          proposedEdit: { op: 'delete_question' },
          applyInstruction: 'Only if it is really needed.',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(steerProposedEdit).not.toHaveBeenCalled();
    expect(applyFinding).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ findingId: 'gone', reason: 'steer_unsupported' });
  });

  it('lets one failed steer through without taking the rest of the batch with it', async () => {
    applyLands();
    steerMockFn.mockImplementation((input) =>
      Promise.resolve(
        input.instruction === 'bad'
          ? { ok: false as const, code: 'steer_failed', message: 'No.' }
          : {
              ok: true as const,
              edit: { op: 'replace_prompt' as const, prompt: 'Reviewer wording' },
              note: 'Done.',
              unhonoured: null,
            }
      )
    );

    const result = await applyAcceptedFindings({
      findings: [
        row({
          id: 'bad',
          proposedEdit: { op: 'replace_prompt', prompt: 'A' },
          applyInstruction: 'bad',
        }),
        row({
          id: 'good',
          proposedEdit: { op: 'replace_prompt', prompt: 'B' },
          applyInstruction: 'good',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(result.applied.map((a) => a.findingId)).toEqual(['good']);
    expect(result.skipped.map((sk) => sk.findingId)).toEqual(['bad']);
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

  it('judges the first finding against the draft this run already made, not the original', async () => {
    // The bug: `applyFinding` resolves its write target from the run's existing draft, so a batch
    // that started staleness-checking at the run's own version compared its first finding against a
    // questionnaire it was not editing. Press Apply, press it again — which the half-triaged
    // confirmation explicitly invites — and the second batch's first finding reads as not-stale
    // against the untouched original, then silently overwrites what the first batch wrote.
    // Nothing applies, so the reported version is the one the batch OPENED on rather than one an
    // outcome overwrote — which is the value under test.
    applyFindingMock.mockResolvedValue({ status: 'unapplicable', reason: 'stale' });
    runAlreadyEditingDraft('v3', 3);

    const result = await applyAcceptedFindings({
      findings: [row({ proposedEdit: { op: 'replace_prompt', prompt: 'One' } })],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect((buildEvaluationStructure as unknown as Mock).mock.calls[0]).toEqual(['qn-1', 'v3']);
    expect(result).toMatchObject({ versionId: 'v3', versionNumber: 3 });
  });

  it('words a steer against the draft the change will actually land on', async () => {
    // Same root cause, and the same wrong answer in a different place: a rewrite reasoned about
    // the launched original would be steering wording that no longer exists on the draft.
    applyLands();
    runAlreadyEditingDraft('v3', 3);
    steerMockFn.mockResolvedValue({
      ok: true,
      edit: { op: 'replace_prompt', prompt: 'Reviewer wording' },
      note: 'Done.',
      unhonoured: null,
    });

    await applyAcceptedFindings({
      findings: [
        row({
          proposedEdit: { op: 'replace_prompt', prompt: 'One' },
          applyInstruction: 'Plainer, please.',
        }),
      ],
      runId: 'run1',
      questionnaireId: 'qn-1',
      scoped,
      snapshot: structure(),
      audit,
    });

    expect(steerMockFn.mock.calls[0][1]).toMatchObject({ versionId: 'v3' });
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

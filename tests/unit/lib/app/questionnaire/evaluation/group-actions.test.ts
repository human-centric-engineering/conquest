/**
 * Unit test: reducing a question's findings to the action the panel proposes.
 *
 * The headline verb on a collapsed card is the most-read text on the run-detail page, and the one
 * most able to mislead. These cases are about the two ways it could: by inventing a consensus the
 * judges never reached, and by hiding a destructive proposal behind a gentler one.
 */

import { describe, it, expect } from 'vitest';

import { summariseGroupActions } from '@/lib/app/questionnaire/evaluation/group-actions';
import { groupFindingsByTarget } from '@/lib/app/questionnaire/evaluation/group-findings';
import type { EvaluationDimension, ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type { EvaluationFindingView } from '@/lib/app/questionnaire/views';

let seq = 0;

function finding(
  dimension: EvaluationDimension,
  proposedEdit: ProposedEdit | null,
  over: Partial<EvaluationFindingView> = {}
): EvaluationFindingView {
  seq += 1;
  return {
    id: `f${seq}`,
    dimension,
    ordinal: seq,
    targetKey: 'q1',
    target: {
      kind: 'question',
      key: 'q1',
      label: 'A question?',
      sectionTitle: 'Background',
      position: 1,
      sectionPosition: 1,
      questionType: 'free_text',
      removed: false,
    },
    severity: 'minor',
    proposedChange: 'Do the thing.',
    rationale: 'Because.',
    sourceQuote: null,
    status: 'pending',
    proposedEdit,
    editedOverride: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'apply',
    ...over,
  };
}

/** Group a set of findings the way the page does, then summarise the one group they form. */
function summarise(findings: EvaluationFindingView[]) {
  const [group] = groupFindingsByTarget(findings);
  return summariseGroupActions(group);
}

const REWORD: ProposedEdit = { op: 'replace_prompt', prompt: 'Better?' };
const DELETE: ProposedEdit = { op: 'delete_question' };
const MOVE: ProposedEdit = { op: 'reorder', ordinal: 0 };

describe('summariseGroupActions', () => {
  it('leads with the action the most judges proposed', () => {
    const summary = summarise([
      finding('clarity', REWORD),
      finding('audience_match', REWORD),
      finding('goal_match', DELETE),
    ]);

    expect(summary.primary?.kind).toBe('reword');
    expect(summary.primary?.judges).toEqual(['clarity', 'audience_match']);
    expect(summary.primary?.label).toBe('Reword it');
  });

  it('keeps the dissent instead of flattening it into the winner', () => {
    // The whole point: two judges wanting a rewrite while a third wants the question gone is not
    // "reword" — it is a decision the reviewer has to make, and they need both halves to make it.
    const summary = summarise([
      finding('clarity', REWORD),
      finding('audience_match', REWORD),
      finding('goal_match', DELETE),
    ]);

    expect(summary.contested).toBe(true);
    expect(summary.others.map((o) => o.kind)).toEqual(['delete']);
    expect(summary.others[0].judges).toEqual(['goal_match']);
  });

  it('is not contested when every judge asked for the same thing', () => {
    const summary = summarise([finding('clarity', REWORD), finding('audience_match', REWORD)]);

    expect(summary.contested).toBe(false);
    expect(summary.others).toEqual([]);
  });

  it('breaks a tie toward the more destructive action', () => {
    // One judge each. Surfacing "reword" would let a reviewer skim past a proposed deletion and
    // meet it only after opening the card — the surprise this ordering exists to prevent.
    const summary = summarise([finding('clarity', REWORD), finding('goal_match', DELETE)]);

    expect(summary.primary?.kind).toBe('delete');
    expect(summary.others.map((o) => o.kind)).toEqual(['reword']);
  });

  it('orders a three-way tie by consequence throughout', () => {
    const summary = summarise([
      finding('clarity', REWORD),
      finding('ordering', MOVE),
      finding('goal_match', DELETE),
    ]);

    expect([summary.primary?.kind, ...summary.others.map((o) => o.kind)]).toEqual([
      'delete',
      'move',
      'reword',
    ]);
  });

  it('counts judges, not findings — one judge repeating itself is one voice', () => {
    // Two rewrite findings from the same judge must not outvote one deletion from another.
    const summary = summarise([
      finding('clarity', REWORD),
      finding('clarity', REWORD),
      finding('goal_match', DELETE),
    ]);

    expect(summary.primary?.kind).toBe('delete');
    const reword = summary.others.find((o) => o.kind === 'reword');
    expect(reword?.judges).toEqual(['clarity']);
    // Both findings still travel, so the drill-down shows everything that was said.
    expect(reword?.findings).toHaveLength(2);
  });

  it('follows the admin’s edited op, not the judge’s original', () => {
    // `editedOverride` is what apply actually runs. A header reading "Reword it" over a button
    // that deletes the question would be lying about its own control.
    const summary = summarise([
      finding('clarity', REWORD, { editedOverride: DELETE }),
      finding('audience_match', REWORD, { editedOverride: DELETE }),
    ]);

    expect(summary.primary?.kind).toBe('delete');
    expect(summary.contested).toBe(false);
  });

  it('falls back to "Review" for a prose-only finding, and never lets it outrank a real op', () => {
    const proseOnly = summarise([finding('clarity', null)]);
    expect(proseOnly.primary?.kind).toBe('review');
    expect(proseOnly.primary?.label).toBe('Review it');

    // Tied on one judge each, an actual proposal wins over the absence of one.
    const mixed = summarise([finding('clarity', null), finding('audience_match', REWORD)]);
    expect(mixed.primary?.kind).toBe('reword');
  });

  it('reports the distinct judge count for the whole target', () => {
    const summary = summarise([
      finding('clarity', REWORD),
      finding('clarity', DELETE),
      finding('ordering', MOVE),
    ]);

    // Three findings, two judges — the card's denominator counts judges, not findings.
    expect(summary.judgeCount).toBe(2);
  });

  it('is stable: the same findings always produce the same headline', () => {
    const findings = [
      finding('clarity', REWORD),
      finding('ordering', MOVE),
      finding('audience_match', REWORD),
    ];
    const first = summarise(findings);
    const second = summarise(findings);

    expect(first.primary?.kind).toBe(second.primary?.kind);
    expect(first.others.map((o) => o.kind)).toEqual(second.others.map((o) => o.kind));
  });
});

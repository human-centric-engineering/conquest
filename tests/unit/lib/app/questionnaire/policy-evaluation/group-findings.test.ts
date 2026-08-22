/**
 * Grouping policy findings by target.
 *
 * This does the job a reconciler would otherwise do. The panel has no reconcile step *and* a real
 * collision case — three of its four dimensions can propose an edit to the same field of the same
 * object — so grouping is what puts two competing proposals on one card with both rationales
 * visible, for the reviewer to choose between.
 *
 * @see lib/app/questionnaire/policy-evaluation/group-findings.ts
 */

import { describe, it, expect } from 'vitest';

import {
  groupPolicyFindingsByTarget,
  tallyPolicySeverities,
} from '@/lib/app/questionnaire/policy-evaluation/group-findings';
import type { PolicyEvaluationFindingView } from '@/lib/app/questionnaire/views';

function finding(over: Partial<PolicyEvaluationFindingView> = {}): PolicyEvaluationFindingView {
  return {
    id: 'f1',
    dimension: 'rule_coherence',
    ordinal: 0,
    targetKey: 'house_rule:r1',
    target: {
      kind: 'house_rule',
      key: 'house_rule:r1',
      label: 'Never use humour.',
      removed: false,
    },
    severity: 'minor',
    proposedChange: 'Say what it means.',
    rationale: 'Too vague.',
    sourceQuote: null,
    status: 'pending',
    proposedEdit: null,
    editedOverride: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'manual',
    ...over,
  };
}

describe('groupPolicyFindingsByTarget', () => {
  it('gathers two judges flagging one target onto a single group', () => {
    // The collision case, and the reason grouping replaces a reconciler here.
    const groups = groupPolicyFindingsByTarget([
      finding({ id: 'a', dimension: 'rule_coherence' }),
      finding({ id: 'b', dimension: 'cross_layer_conflict' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(2);
    // Both rationales stay visible, and the card can say "2 reviewers flagged this".
    expect(groups[0].dimensions).toEqual(['rule_coherence', 'cross_layer_conflict']);
  });

  it('orders from the broadest subject to the narrowest', () => {
    // A reviewer reads the framing before the detail: whole-policy blocks, then individual rules,
    // then per-question fidelity — of which there can be many, each the smallest possible change.
    const groups = groupPolicyFindingsByTarget([
      finding({
        id: 'q',
        targetKey: 'question:q1',
        target: { kind: 'question', key: 'question:q1', label: 'Fidelity — “x”', removed: false },
      }),
      finding({
        id: 's',
        targetKey: 'strategy',
        target: {
          kind: 'strategy',
          key: 'strategy',
          label: 'Questioning approach',
          removed: false,
        },
      }),
      finding({ id: 'r' }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['strategy', 'house_rule', 'question']);
  });

  it('still groups a finding whose target failed to resolve', () => {
    const groups = groupPolicyFindingsByTarget([
      finding({ id: 'x', targetKey: 'house_rule:gone', target: null }),
    ]);
    expect(groups).toHaveLength(1);
    // Falls back to the raw key rather than dropping the finding.
    expect(groups[0].label).toBe('house_rule:gone');
    expect(groups[0].kind).toBe('unknown');
  });

  it('sinks removed targets below live ones of the same kind', () => {
    const groups = groupPolicyFindingsByTarget([
      finding({
        id: 'gone',
        targetKey: 'house_rule:r0',
        target: {
          kind: 'house_rule',
          key: 'house_rule:r0',
          label: 'A deleted rule',
          removed: true,
        },
      }),
      finding({ id: 'live' }),
    ]);
    expect(groups.map((g) => g.removed)).toEqual([false, true]);
  });

  it('can sort by severity when the reviewer wants worst-first', () => {
    const groups = groupPolicyFindingsByTarget(
      [
        finding({ id: 'minor' }),
        finding({
          id: 'major',
          severity: 'major',
          targetKey: 'strategy',
          target: { kind: 'strategy', key: 'strategy', label: 'Approach', removed: false },
        }),
      ],
      'major'
    );
    expect(groups[0].counts.major).toBe(1);
  });
});

describe('tallyPolicySeverities', () => {
  it('counts each band and the total', () => {
    expect(
      tallyPolicySeverities([
        finding({ severity: 'major' }),
        finding({ severity: 'minor' }),
        finding({ severity: 'info' }),
        finding({ severity: 'info' }),
      ])
    ).toEqual({ major: 1, minor: 1, info: 2, total: 4 });
  });
});

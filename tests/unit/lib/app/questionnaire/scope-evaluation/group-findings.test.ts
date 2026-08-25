/**
 * Unit tests for the by-target regrouping of scope-evaluation findings (F17.21).
 *
 * Mirrors `evaluation/group-findings.test.ts`'s coverage (nothing dropped, tallies correct,
 * distinct-judge tracking, every sort mode) over the simpler kind-rank ordering this module uses
 * (settings, then topic, then rule, unknown last) — there is no gap-group or section-position
 * concept here, unlike the design-evaluation sibling.
 */

import { describe, it, expect } from 'vitest';

import {
  groupScopeFindingsByTarget,
  tallyScopeSeverities,
  type ScopeFindingGroup,
} from '@/lib/app/questionnaire/scope-evaluation/group-findings';
import type {
  ScopeEvaluationFindingView,
  ScopeFindingTargetView,
} from '@/lib/app/questionnaire/views';
import type { FindingSeverity } from '@/lib/app/questionnaire/evaluation';

let seq = 0;

function target(over: Partial<ScopeFindingTargetView> = {}): ScopeFindingTargetView {
  return {
    kind: 'topic',
    key: 'talent',
    label: 'Talent & culture',
    removed: false,
    ...over,
  };
}

function finding(
  over: Partial<ScopeEvaluationFindingView> & { target?: ScopeFindingTargetView | null } = {}
): ScopeEvaluationFindingView {
  const t = 'target' in over ? over.target : target();
  return {
    id: `f${seq++}`,
    dimension: 'criteria_quality',
    ordinal: 0,
    targetKey: t?.key ?? 'topic:talent',
    target: t ?? null,
    severity: 'minor',
    proposedChange: 'change',
    rationale: 'because',
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

/** A topic target with the given key/label, flagged with the given severities. */
function topicWith(key: string, label: string, severities: FindingSeverity[]) {
  return severities.map((severity) => finding({ severity, target: target({ key, label }) }));
}

const keysOf = (groups: ScopeFindingGroup[]) => groups.map((g) => g.key);

describe('groupScopeFindingsByTarget', () => {
  it('gathers every finding about one target into a single group', () => {
    const groups = groupScopeFindingsByTarget([
      ...topicWith('talent', 'Talent & culture', ['major', 'minor', 'info']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(3);
    expect(groups[0].counts).toEqual({ major: 1, minor: 1, info: 1, total: 3 });
  });

  it('records the distinct judges (dimensions) that flagged a target, in first-seen order', () => {
    const groups = groupScopeFindingsByTarget([
      finding({ dimension: 'rule_integrity' }),
      finding({ dimension: 'criteria_quality' }),
      finding({ dimension: 'rule_integrity' }), // repeat — must not duplicate
    ]);
    expect(groups[0].dimensions).toEqual(['rule_integrity', 'criteria_quality']);
  });

  it('drops nothing — every finding lands in exactly one group', () => {
    const findings = [
      ...topicWith('talent', 'Talent & culture', ['major']),
      finding({ target: target({ kind: 'rule', key: 'rule-1', label: 'A rule sentence' }) }),
      finding({
        target: target({ kind: 'settings', key: 'settings', label: 'Conditional topics settings' }),
      }),
      finding({ target: target({ kind: 'unknown', key: 'invented', label: 'invented' }) }),
      finding({ target: null, targetKey: 'unresolved' }),
    ];
    const groups = groupScopeFindingsByTarget(findings);
    const regrouped = groups.flatMap((g) => g.findings);
    expect(regrouped).toHaveLength(findings.length);
    expect(new Set(regrouped.map((f) => f.id)).size).toBe(findings.length);
  });

  it('groups an unresolved target on its raw targetKey, labelled with that key', () => {
    const groups = groupScopeFindingsByTarget([
      finding({ target: null, targetKey: 'topic:ghost' }),
    ]);
    expect(groups[0].key).toBe('topic:ghost');
    expect(groups[0].label).toBe('topic:ghost');
    expect(groups[0].kind).toBe('unknown');
  });

  it('counts an anomalous stored severity in the total without corrupting a tally', () => {
    // `severity` is a plain String column, so a future/unknown value must degrade, not throw.
    const groups = groupScopeFindingsByTarget([
      finding({ severity: 'catastrophic' as FindingSeverity }),
      finding({ severity: 'major' }),
    ]);
    expect(groups[0].counts).toEqual({ major: 1, minor: 0, info: 0, total: 2 });
  });

  describe('natural order', () => {
    it('leads with settings, then topics, then rules, sinking unknown below all of them', () => {
      const groups = groupScopeFindingsByTarget([
        finding({ target: target({ kind: 'rule', key: 'rule-1', label: 'Rule' }) }),
        finding({ target: target({ kind: 'unknown', key: 'zz', label: 'zz' }) }),
        ...topicWith('talent', 'Talent & culture', ['minor']),
        finding({
          target: target({
            kind: 'settings',
            key: 'settings',
            label: 'Conditional topics settings',
          }),
        }),
      ]);
      expect(keysOf(groups)).toEqual(['settings', 'talent', 'rule-1', 'zz']);
    });

    it('sorts targets of the same kind alphabetically by label', () => {
      const groups = groupScopeFindingsByTarget([
        ...topicWith('b', 'Zebra topic', ['minor']),
        ...topicWith('a', 'Alpha topic', ['minor']),
      ]);
      expect(keysOf(groups)).toEqual(['a', 'b']);
    });

    it('sorts a removed target after a live one at the same rank', () => {
      const groups = groupScopeFindingsByTarget([
        finding({ target: target({ key: 'gone', label: 'Aaa gone', removed: true }) }),
        ...topicWith('live', 'Zzz live', ['minor']),
      ]);
      // `gone` sorts alphabetically before `live`, but `removed` pushes it after.
      expect(keysOf(groups)).toEqual(['live', 'gone']);
    });
  });

  describe('major order', () => {
    it('puts the most-major target first regardless of kind rank', () => {
      const groups = groupScopeFindingsByTarget(
        [
          ...topicWith('first', 'First', ['major']),
          finding({
            target: target({ kind: 'settings', key: 'settings', label: 'Settings' }),
            severity: 'major',
          }),
          finding({
            target: target({ kind: 'settings', key: 'settings', label: 'Settings' }),
            severity: 'major',
          }),
        ],
        'major'
      );
      expect(keysOf(groups)).toEqual(['settings', 'first']);
    });

    it('breaks a major tie on total findings, then on natural order', () => {
      const groups = groupScopeFindingsByTarget(
        [
          // All three have exactly one major.
          ...topicWith('c', 'C topic', ['major']),
          ...topicWith('a', 'A topic', ['major', 'minor']), // 2 findings — wins the tiebreak
          ...topicWith('b', 'B topic', ['major']),
        ],
        'major'
      );
      // `a` first on total; `b` before `c` on natural (alphabetical) order.
      expect(keysOf(groups)).toEqual(['a', 'b', 'c']);
    });

    it('ranks a single major above any number of minors', () => {
      const groups = groupScopeFindingsByTarget(
        [
          ...topicWith('noisy', 'Noisy', ['minor', 'minor', 'minor', 'info']),
          ...topicWith('serious', 'Serious', ['major']),
        ],
        'major'
      );
      expect(keysOf(groups)).toEqual(['serious', 'noisy']);
    });
  });

  describe('findings order', () => {
    it('sorts by total finding count, then natural', () => {
      const groups = groupScopeFindingsByTarget(
        [
          ...topicWith('a', 'A', ['major']),
          ...topicWith('b', 'B', ['info', 'info', 'info']),
          ...topicWith('c', 'C', ['minor']),
        ],
        'findings'
      );
      expect(keysOf(groups)).toEqual(['b', 'a', 'c']);
    });
  });

  it('produces a total order — re-sorting the same input is stable', () => {
    const findings = [
      ...topicWith('a', 'A', ['major']),
      ...topicWith('b', 'B', ['major']),
      ...topicWith('c', 'C', ['major']),
    ];
    const once = keysOf(groupScopeFindingsByTarget(findings, 'major'));
    const twice = keysOf(groupScopeFindingsByTarget([...findings].reverse(), 'major'));
    expect(twice).toEqual(once);
  });
});

describe('tallyScopeSeverities', () => {
  it('tallies across a whole finding list, independent of target', () => {
    const counts = tallyScopeSeverities([
      ...topicWith('a', 'A', ['major', 'major']),
      ...topicWith('b', 'B', ['minor', 'info']),
    ]);
    expect(counts).toEqual({ major: 2, minor: 1, info: 1, total: 4 });
  });

  it('returns all-zero counts for an empty list', () => {
    expect(tallyScopeSeverities([])).toEqual({ major: 0, minor: 0, info: 0, total: 0 });
  });
});

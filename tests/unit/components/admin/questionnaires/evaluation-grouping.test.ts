/**
 * Unit tests for the by-question regrouping of evaluation findings.
 *
 * These cover the ordering logic properly (the component test only asserts the control is wired
 * to it) and the two things a regrouping can silently get wrong: dropping findings whose target
 * isn't a question, and producing an unstable order for equally-severe targets.
 */

import { describe, it, expect } from 'vitest';

import {
  groupFindingsByTarget,
  tallySeverities,
  groupContextLabel,
  type FindingGroup,
} from '@/components/admin/questionnaires/evaluation-grouping';
import type { EvaluationFindingView, FindingTargetView } from '@/lib/app/questionnaire/views';
import type { FindingSeverity } from '@/lib/app/questionnaire/evaluation';

let seq = 0;

function target(over: Partial<FindingTargetView> = {}): FindingTargetView {
  return {
    kind: 'question',
    key: 'q1',
    label: 'A question',
    sectionTitle: 'Section A',
    position: 1,
    sectionPosition: 1,
    questionType: 'likert',
    removed: false,
    ...over,
  };
}

function finding(
  over: Partial<EvaluationFindingView> & { target?: FindingTargetView | null } = {}
): EvaluationFindingView {
  const t = 'target' in over ? over.target : target();
  return {
    id: `f${seq++}`,
    dimension: 'clarity',
    ordinal: 0,
    targetKey: t?.key ?? 'q1',
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

/** A question in section `sec` at position `pos`, flagged with the given severities. */
function questionWith(
  key: string,
  sec: number,
  pos: number,
  severities: FindingSeverity[]
): EvaluationFindingView[] {
  return severities.map((severity) =>
    finding({
      severity,
      target: target({ key, label: `Q ${key}`, sectionPosition: sec, position: pos }),
    })
  );
}

const keysOf = (groups: FindingGroup[]) => groups.map((g) => g.key);

describe('groupFindingsByTarget', () => {
  it('gathers every finding about one target into a single group', () => {
    const groups = groupFindingsByTarget([...questionWith('q1', 1, 1, ['major', 'minor', 'info'])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(3);
    expect(groups[0].counts).toEqual({ major: 1, minor: 1, info: 1, total: 3 });
  });

  it('records the distinct judges that flagged a target, in first-seen order', () => {
    const groups = groupFindingsByTarget([
      finding({ dimension: 'type_fit' }),
      finding({ dimension: 'clarity' }),
      finding({ dimension: 'type_fit' }), // repeat — must not duplicate
    ]);
    expect(groups[0].dimensions).toEqual(['type_fit', 'clarity']);
  });

  it('drops nothing — every finding lands in exactly one group', () => {
    const findings = [
      ...questionWith('q1', 1, 1, ['major']),
      finding({ target: target({ kind: 'section', key: 'section:Intro', label: 'Intro' }) }),
      finding({ target: target({ kind: 'goal', key: 'goal', label: 'Questionnaire goal' }) }),
      finding({ target: target({ kind: 'audience', key: 'audience', label: 'Target audience' }) }),
      finding({ target: target({ kind: 'unknown', key: 'invented', label: 'invented' }) }),
      finding({ target: null, targetKey: 'unresolved' }),
    ];
    const groups = groupFindingsByTarget(findings);
    const regrouped = groups.flatMap((g) => g.findings);
    expect(regrouped).toHaveLength(findings.length);
    expect(new Set(regrouped.map((f) => f.id)).size).toBe(findings.length);
  });

  it('groups an unresolved target on its raw key, labelled with that key', () => {
    const groups = groupFindingsByTarget([finding({ target: null, targetKey: 'q_ghost' })]);
    expect(groups[0].key).toBe('q_ghost');
    expect(groups[0].label).toBe('q_ghost');
    expect(groups[0].kind).toBe('unknown');
  });

  it('counts an anomalous stored severity in the total without corrupting a tally', () => {
    // `severity` is a plain String column, so a future/unknown value must degrade, not throw.
    const groups = groupFindingsByTarget([
      finding({ severity: 'catastrophic' as FindingSeverity }),
      finding({ severity: 'major' }),
    ]);
    expect(groups[0].counts).toEqual({ major: 1, minor: 0, info: 0, total: 2 });
  });

  describe('natural order', () => {
    it('sorts by section then position within section', () => {
      const groups = groupFindingsByTarget([
        ...questionWith('b', 2, 1, ['minor']),
        ...questionWith('c', 1, 2, ['minor']),
        ...questionWith('a', 1, 1, ['minor']),
      ]);
      expect(keysOf(groups)).toEqual(['a', 'c', 'b']);
    });

    it('pins the version-level targets above the structure', () => {
      const groups = groupFindingsByTarget([
        ...questionWith('q1', 1, 1, ['minor']),
        finding({ target: target({ kind: 'audience', key: 'audience', label: 'Audience' }) }),
        finding({ target: target({ kind: 'goal', key: 'goal', label: 'Goal' }) }),
      ]);
      expect(keysOf(groups)).toEqual(['goal', 'audience', 'q1']);
    });

    it('sinks unknown targets below real ones', () => {
      const groups = groupFindingsByTarget([
        finding({ target: target({ kind: 'unknown', key: 'zz_invented', label: 'zz' }) }),
        ...questionWith('q1', 1, 1, ['minor']),
      ]);
      expect(keysOf(groups)).toEqual(['q1', 'zz_invented']);
    });

    it('sorts a removed target after a live one at the same rank', () => {
      const groups = groupFindingsByTarget([
        finding({
          target: target({ key: 'gone', sectionPosition: 1, position: 1, removed: true }),
        }),
        ...questionWith('live', 1, 2, ['minor']),
      ]);
      // `gone` is earlier positionally but is history, so the live question leads.
      expect(keysOf(groups)).toEqual(['live', 'gone']);
    });

    it('sorts a target with no position last rather than first', () => {
      const groups = groupFindingsByTarget([
        finding({
          target: target({ key: 'nopos', sectionPosition: null, position: null }),
        }),
        ...questionWith('q1', 9, 9, ['minor']),
      ]);
      expect(keysOf(groups)).toEqual(['q1', 'nopos']);
    });
  });

  describe('major order', () => {
    it('puts the most-major target first regardless of its position', () => {
      const groups = groupFindingsByTarget(
        [
          ...questionWith('first', 1, 1, ['major']),
          ...questionWith('last', 9, 9, ['major', 'major']),
        ],
        'major'
      );
      expect(keysOf(groups)).toEqual(['last', 'first']);
    });

    it('breaks a major tie on total findings, then on natural order', () => {
      const groups = groupFindingsByTarget(
        [
          // All three have exactly one major.
          ...questionWith('c', 3, 1, ['major']),
          ...questionWith('a', 1, 1, ['major', 'minor']), // 2 findings — wins the tiebreak
          ...questionWith('b', 2, 1, ['major']),
        ],
        'major'
      );
      // `a` first on total; `b` before `c` on natural order.
      expect(keysOf(groups)).toEqual(['a', 'b', 'c']);
    });

    it('ranks a single major above any number of minors', () => {
      const groups = groupFindingsByTarget(
        [
          ...questionWith('noisy', 1, 1, ['minor', 'minor', 'minor', 'info']),
          ...questionWith('serious', 2, 1, ['major']),
        ],
        'major'
      );
      expect(keysOf(groups)).toEqual(['serious', 'noisy']);
    });
  });

  describe('findings order', () => {
    it('sorts by total finding count, then natural', () => {
      const groups = groupFindingsByTarget(
        [
          ...questionWith('a', 1, 1, ['major']),
          ...questionWith('b', 2, 1, ['info', 'info', 'info']),
          ...questionWith('c', 3, 1, ['minor']),
        ],
        'findings'
      );
      expect(keysOf(groups)).toEqual(['b', 'a', 'c']);
    });
  });

  it('produces a total order — re-sorting the same input is stable', () => {
    const findings = [
      ...questionWith('a', 1, 1, ['major']),
      ...questionWith('b', 1, 2, ['major']),
      ...questionWith('c', 2, 1, ['major']),
    ];
    const once = keysOf(groupFindingsByTarget(findings, 'major'));
    const twice = keysOf(groupFindingsByTarget([...findings].reverse(), 'major'));
    expect(twice).toEqual(once);
  });
});

describe('tallySeverities', () => {
  it('counts each level and the total', () => {
    expect(
      tallySeverities([
        finding({ severity: 'major' }),
        finding({ severity: 'major' }),
        finding({ severity: 'minor' }),
        finding({ severity: 'info' }),
      ])
    ).toEqual({ major: 2, minor: 1, info: 1, total: 4 });
  });

  it('returns zeroes for an empty run', () => {
    expect(tallySeverities([])).toEqual({ major: 0, minor: 0, info: 0, total: 0 });
  });
});

describe('groupContextLabel', () => {
  const group = (over: Partial<FindingGroup>): FindingGroup => ({
    key: 'k',
    kind: 'question',
    label: 'l',
    sectionTitle: 'Background',
    sectionPosition: 1,
    position: 3,
    questionType: 'likert',
    removed: false,
    gap: false,
    findings: [],
    counts: { major: 0, minor: 0, info: 0, total: 0 },
    dimensions: [],
    ...over,
  });

  it('names a question by position and section', () => {
    expect(groupContextLabel(group({}))).toBe('Q3 · Background');
  });

  it('omits the section when there is none', () => {
    expect(groupContextLabel(group({ sectionTitle: null }))).toBe('Q3');
  });

  it('labels the version-level targets', () => {
    expect(groupContextLabel(group({ kind: 'goal' }))).toBe('Goal');
    expect(groupContextLabel(group({ kind: 'audience' }))).toBe('Audience');
  });

  it('numbers a section target', () => {
    expect(groupContextLabel(group({ kind: 'section', sectionPosition: 2 }))).toBe('Section 2');
  });

  it('has nothing positional to say about an unknown target', () => {
    expect(groupContextLabel(group({ kind: 'unknown' }))).toBeNull();
  });

  it('never labels a gap group "Goal", even though it carries kind goal', () => {
    // The Coverage judge addresses gaps at `goal` because a missing question has no key to target.
    // Labelling that "Goal" says the finding edits the goal statement, which it never does.
    const counts = { major: 0, minor: 0, info: 0, total: 2 };
    expect(groupContextLabel(group({ kind: 'goal', gap: true, counts }))).toBe('Coverage gaps');
  });

  it('says "gap" in the singular for a lone drafted question', () => {
    const counts = { major: 0, minor: 0, info: 0, total: 1 };
    expect(groupContextLabel(group({ kind: 'goal', gap: true, counts }))).toBe('Coverage gap');
  });
});

describe('coverage gaps split out from the goal', () => {
  /** A drafted new question, as the Coverage judge emits it: addressed at `goal`. */
  function gapFinding(prompt: string, over: Partial<EvaluationFindingView> = {}) {
    return finding({
      dimension: 'coverage',
      targetKey: 'goal',
      target: target({ kind: 'goal', key: 'goal', label: 'Questionnaire goal' }),
      proposedEdit: { op: 'add_question', prompt, type: 'free_text' },
      applicable: 'deep-link',
      ...over,
    });
  }

  it('groups drafted questions away from the goal, under their own label', () => {
    const groups = groupFindingsByTarget([gapFinding('How big is your team?')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].gap).toBe(true);
    expect(groups[0].label).toBe('Questions not yet asked');
    // The whole point: nothing on this group says "Questionnaire goal".
    expect(groups[0].label).not.toContain('goal');
  });

  it('keeps a real goal edit under the goal, separate from the gaps', () => {
    const groups = groupFindingsByTarget([
      gapFinding('How big is your team?'),
      finding({
        dimension: 'goal_match',
        targetKey: 'goal',
        target: target({ kind: 'goal', key: 'goal', label: 'Questionnaire goal' }),
        proposedEdit: { op: 'edit_goal', goal: 'A better goal' },
      }),
    ]);
    expect(groups).toHaveLength(2);
    const goalGroup = groups.find((g) => !g.gap);
    expect(goalGroup?.label).toBe('Questionnaire goal');
    expect(goalGroup?.findings).toHaveLength(1);
  });

  it('collects every drafted question into one group, whatever it was addressed to', () => {
    // A draft is about the questionnaire's missing coverage, not about the target it was hung on.
    const groups = groupFindingsByTarget([
      gapFinding('How big is your team?'),
      gapFinding('What is your budget?', {
        targetKey: 'section:Background',
        target: target({ kind: 'section', key: 'section:Background', label: 'Background' }),
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(2);
  });

  it("follows the admin's edit when it turns a draft into an in-place op", () => {
    // `editedOverride` is what actually applies, so it decides the group too.
    const groups = groupFindingsByTarget([
      gapFinding('How big is your team?', {
        targetKey: 'q1',
        target: target({ key: 'q1', label: 'A question' }),
        editedOverride: { op: 'replace_prompt', prompt: 'Reworded' },
      }),
    ]);
    expect(groups[0].gap).toBe(false);
    expect(groups[0].label).toBe('A question');
  });

  it('sorts gaps after the goal but before the questions', () => {
    const groups = groupFindingsByTarget([
      ...questionWith('q1', 1, 1, ['minor']),
      gapFinding('How big is your team?'),
      finding({
        targetKey: 'goal',
        target: target({ kind: 'goal', key: 'goal', label: 'Questionnaire goal' }),
        proposedEdit: { op: 'edit_goal', goal: 'A better goal' },
      }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Questionnaire goal',
      'Questions not yet asked',
      'Q q1',
    ]);
  });

  it('carries no answer type on a gap group, since each draft names its own', () => {
    const groups = groupFindingsByTarget([
      gapFinding('How big is your team?'),
      gapFinding('Rate your morale', {
        proposedEdit: { op: 'add_question', prompt: 'Rate your morale', type: 'likert' },
      }),
    ]);
    expect(groups[0].questionType).toBeNull();
    expect(groups[0].removed).toBe(false);
  });
});

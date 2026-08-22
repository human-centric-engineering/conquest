/**
 * Regroup a policy-evaluation run's findings by what they are about (F18.8).
 *
 * Mirrors both siblings' rationale — a target several judges flagged is the strongest signal a run
 * carries, and in dispatch order those findings sit apart with nothing tying them together.
 *
 * It matters more here than on either sibling, because this panel has **no reconcile step and a real
 * collision case**: three of its four dimensions can propose an edit to the same field of the same
 * object. Grouping is what does the reconciler's presentation job — both proposals land on one card
 * with both rationales visible, and the reviewer picks. See `run-panel.ts`'s module doc.
 *
 * No gap-group special case: no op drafts something that does not exist yet the way `add_question`
 * does, so every finding groups by its resolved target.
 *
 * Pure — findings in, groups out. No React, no Prisma, no fetching.
 */

import type {
  PolicyEvaluationFindingView,
  PolicyFindingTargetKind,
} from '@/lib/app/questionnaire/views';
import type { PolicyEvaluationDimension } from '@/lib/app/questionnaire/policy-evaluation/types';

/** Severity tallies for one target (or a whole run). */
export interface PolicySeverityCounts {
  major: number;
  minor: number;
  info: number;
  total: number;
}

/** Every finding a run raised about one target, plus the tallies the UI sorts and labels on. */
export interface PolicyFindingGroup {
  /** `target.key` when resolved, else the raw `targetKey` — unique per target within a run. */
  key: string;
  kind: PolicyFindingTargetKind;
  /** The rule's text, the question's prompt, or the block's name. */
  label: string;
  /** The target no longer exists in the live config (named from the run's snapshot). */
  removed: boolean;
  /** Findings about this target, in their original `(dimension, ordinal)` order. */
  findings: PolicyEvaluationFindingView[];
  counts: PolicySeverityCounts;
  /** Distinct judges that flagged this target, first-seen order. */
  dimensions: PolicyEvaluationDimension[];
}

/**
/**
 * Ordered from the broadest subject to the narrowest, so a reviewer reads the framing before the
 * detail: the whole-policy blocks first (strategy, then the rule set, then the fidelity gate, then
 * tone), individual rules next, per-question fidelity last — there can be many of those and each is
 * the smallest possible change. `unknown` sinks below everything real.
 */
const KIND_RANK: Record<PolicyFindingTargetKind, number> = {
  strategy: 0,
  house_rules: 1,
  fidelity: 2,
  tone: 3,
  house_rule: 4,
  question: 5,
  unknown: 6,
};

function emptyCounts(): PolicySeverityCounts {
  return { major: 0, minor: 0, info: 0, total: 0 };
}

/** Rank first by kind, `removed` targets after live ones of the same rank, then label alpha. */
function compareNatural(a: PolicyFindingGroup, b: PolicyFindingGroup): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank;
  if (a.removed !== b.removed) return a.removed ? 1 : -1;
  return a.label.localeCompare(b.label);
}

export const POLICY_GROUP_SORTS = ['natural', 'major', 'findings'] as const;
export type PolicyGroupSort = (typeof POLICY_GROUP_SORTS)[number];

/**
 * Group `findings` by target and order them. Every finding lands in exactly one group; a
 * finding whose `target` failed to resolve still groups, on its raw `targetKey`.
 */
export function groupPolicyFindingsByTarget(
  findings: readonly PolicyEvaluationFindingView[],
  sort: PolicyGroupSort = 'natural'
): PolicyFindingGroup[] {
  const byKey = new Map<string, PolicyFindingGroup>();

  for (const finding of findings) {
    const target = finding.target;
    const key = target?.key ?? finding.targetKey;

    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind: target?.kind ?? 'unknown',
        label: target?.label ?? finding.targetKey,
        removed: target?.removed ?? false,
        findings: [],
        counts: emptyCounts(),
        dimensions: [],
      };
      byKey.set(key, group);
    }

    group.findings.push(finding);
    group.counts.total += 1;
    if (finding.severity === 'major') group.counts.major += 1;
    else if (finding.severity === 'minor') group.counts.minor += 1;
    else if (finding.severity === 'info') group.counts.info += 1;

    if (!group.dimensions.includes(finding.dimension)) group.dimensions.push(finding.dimension);
  }

  const groups = [...byKey.values()];

  switch (sort) {
    case 'major':
      return groups.sort(
        (a, b) =>
          b.counts.major - a.counts.major || b.counts.total - a.counts.total || compareNatural(a, b)
      );
    case 'findings':
      return groups.sort((a, b) => b.counts.total - a.counts.total || compareNatural(a, b));
    case 'natural':
    default:
      return groups.sort(compareNatural);
  }
}

/** Severity tallies across a whole finding list — the headline band's "how bad is it" numbers. */
export function tallyPolicySeverities(
  findings: readonly PolicyEvaluationFindingView[]
): PolicySeverityCounts {
  const counts = emptyCounts();
  for (const f of findings) {
    counts.total += 1;
    if (f.severity === 'major') counts.major += 1;
    else if (f.severity === 'minor') counts.minor += 1;
    else if (f.severity === 'info') counts.info += 1;
  }
  return counts;
}

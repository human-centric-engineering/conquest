/**
 * Regroup a scope-evaluation run's findings by what they are about (F17.21).
 *
 * Mirrors `evaluation/group-findings.ts`'s rationale — a target three judges flagged is the
 * strongest signal a run carries, and in dispatch order those three findings sit apart with
 * nothing tying them together — but simpler: the scope panel has no gap-group analogue (no op
 * drafts something that doesn't exist yet the way `add_question` does), so every finding groups
 * by its resolved target with no special case.
 *
 * Pure — findings in, groups out. No React, no Prisma, no fetching.
 */

import type {
  ScopeEvaluationFindingView,
  ScopeFindingTargetKind,
} from '@/lib/app/questionnaire/views';
import type { ScopeEvaluationDimension } from '@/lib/app/questionnaire/scope-evaluation/types';

/** Severity tallies for one target (or a whole run). */
export interface ScopeSeverityCounts {
  major: number;
  minor: number;
  info: number;
  total: number;
}

/** Every finding a run raised about one target, plus the tallies the UI sorts and labels on. */
export interface ScopeFindingGroup {
  /** `target.key` when resolved, else the raw `targetKey` — unique per target within a run. */
  key: string;
  kind: ScopeFindingTargetKind;
  /** The topic's label, the rule's rendered sentence, or "Conditional topics settings". */
  label: string;
  /** The target no longer exists in the live config (named from the run's snapshot). */
  removed: boolean;
  /** Findings about this target, in their original `(dimension, ordinal)` order. */
  findings: ScopeEvaluationFindingView[];
  counts: ScopeSeverityCounts;
  /** Distinct judges that flagged this target, first-seen order. */
  dimensions: ScopeEvaluationDimension[];
}

/**
 * `settings` leads (it frames the whole panel, like the goal/audience targets do in the design-
 * evaluation groups), then topics, then rules; `unknown` sinks below the real config.
 */
const KIND_RANK: Record<ScopeFindingTargetKind, number> = {
  settings: 0,
  topic: 1,
  rule: 2,
  unknown: 3,
};

function emptyCounts(): ScopeSeverityCounts {
  return { major: 0, minor: 0, info: 0, total: 0 };
}

/** Rank first by kind, `removed` targets after live ones of the same rank, then label alpha. */
function compareNatural(a: ScopeFindingGroup, b: ScopeFindingGroup): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank;
  if (a.removed !== b.removed) return a.removed ? 1 : -1;
  return a.label.localeCompare(b.label);
}

export const SCOPE_GROUP_SORTS = ['natural', 'major', 'findings'] as const;
export type ScopeGroupSort = (typeof SCOPE_GROUP_SORTS)[number];

/**
 * Group `findings` by target and order them. Every finding lands in exactly one group; a
 * finding whose `target` failed to resolve still groups, on its raw `targetKey`.
 */
export function groupScopeFindingsByTarget(
  findings: readonly ScopeEvaluationFindingView[],
  sort: ScopeGroupSort = 'natural'
): ScopeFindingGroup[] {
  const byKey = new Map<string, ScopeFindingGroup>();

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
export function tallyScopeSeverities(
  findings: readonly ScopeEvaluationFindingView[]
): ScopeSeverityCounts {
  const counts = emptyCounts();
  for (const f of findings) {
    counts.total += 1;
    if (f.severity === 'major') counts.major += 1;
    else if (f.severity === 'minor') counts.minor += 1;
    else if (f.severity === 'info') counts.info += 1;
  }
  return counts;
}

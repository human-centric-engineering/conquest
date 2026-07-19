/**
 * Regroup a run's findings by **what they are about** rather than by which judge said them.
 *
 * The API returns findings ordered by `(dimension, ordinal)` — the order they were *produced*.
 * That is the right shape for "how did the Clarity judge do?" and the wrong shape for the job the
 * admin is actually on this page to do: fix the questionnaire. A question flagged by three judges
 * is the strongest signal a run carries, and in dimension order those three findings sit screens
 * apart with nothing tying them together.
 *
 * So this module rekeys the same findings by `target.key`, tallies severity per target, and offers
 * the three orderings a reviewer wants: questionnaire order, worst-first, and busiest-first.
 *
 * Pure — findings in, groups out. No React, no Prisma, no fetching.
 */

import type { EvaluationDimension } from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  FindingTargetKind,
  FindingTargetView,
} from '@/lib/app/questionnaire/views';

/** Severity tallies for one target. */
export interface SeverityCounts {
  major: number;
  minor: number;
  info: number;
  total: number;
}

/** Every finding a run raised about one target, plus the tallies the UI sorts and labels on. */
export interface FindingGroup {
  /** `target.key` when resolved, else the raw `targetKey` — unique per target within a run. */
  key: string;
  kind: FindingTargetKind;
  /** The question prompt / section title / "Questionnaire goal" — falls back to the raw key. */
  label: string;
  sectionTitle: string | null;
  sectionPosition: number | null;
  position: number | null;
  /** The target no longer exists in the live structure (named from the run's snapshot). */
  removed: boolean;
  /** Findings about this target, in their original `(dimension, ordinal)` order. */
  findings: EvaluationFindingView[];
  counts: SeverityCounts;
  /** Distinct judges that flagged this target, first-seen order — the cross-judge consensus. */
  dimensions: EvaluationDimension[];
}

export const GROUP_SORTS = ['natural', 'major', 'findings'] as const;
export type GroupSort = (typeof GROUP_SORTS)[number];

export const GROUP_SORT_LABELS: Record<GroupSort, string> = {
  natural: 'Questionnaire order',
  major: 'Most major findings',
  findings: 'Most findings',
};

/**
 * Sort weight for the two version-level targets, which have no position in the structure but are
 * conceptually "above" it — the goal and audience frame every question, so they lead.
 * `unknown` (a judge invented a key) and anything `removed` sink below the real structure.
 */
const KIND_RANK: Record<FindingTargetKind, number> = {
  goal: 0,
  audience: 1,
  section: 2,
  question: 2,
  unknown: 3,
};

/** Sorts last — a target with no resolvable position must not displace positioned ones. */
const UNPOSITIONED = Number.MAX_SAFE_INTEGER;

function emptyCounts(): SeverityCounts {
  return { major: 0, minor: 0, info: 0, total: 0 };
}

/**
 * Questionnaire order: version-level targets first, then by (section, position within section).
 * `removed` targets sort after live ones of the same rank — they are history, not work.
 * `label` is the final tiebreak so the order is total and therefore stable across renders.
 */
function compareNatural(a: FindingGroup, b: FindingGroup): number {
  const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (rank !== 0) return rank;

  if (a.removed !== b.removed) return a.removed ? 1 : -1;

  const sec = (a.sectionPosition ?? UNPOSITIONED) - (b.sectionPosition ?? UNPOSITIONED);
  if (sec !== 0) return sec;

  const pos = (a.position ?? UNPOSITIONED) - (b.position ?? UNPOSITIONED);
  if (pos !== 0) return pos;

  return a.label.localeCompare(b.label);
}

/**
 * Group `findings` by target and order them.
 *
 * Every finding lands in exactly one group — the non-question target kinds (`section`, `goal`,
 * `audience`, `unknown`) get groups too, so nothing silently disappears from the view. A finding
 * whose `target` failed to resolve (no structure was loadable) still groups, on its raw
 * `targetKey`, with the key as its label.
 *
 * Both count-based sorts fall back to {@link compareNatural}, so equally-severe targets still read
 * in questionnaire order rather than in an arbitrary insertion order.
 */
export function groupFindingsByTarget(
  findings: readonly EvaluationFindingView[],
  sort: GroupSort = 'natural'
): FindingGroup[] {
  const byKey = new Map<string, FindingGroup>();

  for (const finding of findings) {
    const target: FindingTargetView | null = finding.target;
    const key = target?.key ?? finding.targetKey;

    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind: target?.kind ?? 'unknown',
        label: target?.label ?? finding.targetKey,
        sectionTitle: target?.sectionTitle ?? null,
        sectionPosition: target?.sectionPosition ?? null,
        position: target?.position ?? null,
        removed: target?.removed ?? false,
        findings: [],
        counts: emptyCounts(),
        dimensions: [],
      };
      byKey.set(key, group);
    }

    group.findings.push(finding);
    group.counts.total += 1;
    // `severity` is a plain String column: count only the values we know, so an anomalous stored
    // value inflates `total` (it is a real finding) without corrupting a severity tally.
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
export function tallySeverities(findings: readonly EvaluationFindingView[]): SeverityCounts {
  const counts = emptyCounts();
  for (const f of findings) {
    counts.total += 1;
    if (f.severity === 'major') counts.major += 1;
    else if (f.severity === 'minor') counts.minor += 1;
    else if (f.severity === 'info') counts.info += 1;
  }
  return counts;
}

/**
 * A short context label for a group — "Q3 · Background", "Section 2", "Goal".
 * Returns `null` when there is nothing positional to say, so the caller can omit the chip.
 */
export function groupContextLabel(group: FindingGroup): string | null {
  switch (group.kind) {
    case 'goal':
      return 'Goal';
    case 'audience':
      return 'Audience';
    case 'section':
      return group.sectionPosition !== null ? `Section ${group.sectionPosition}` : 'Section';
    case 'question': {
      const q = group.position !== null ? `Q${group.position}` : null;
      if (q && group.sectionTitle) return `${q} · ${group.sectionTitle}`;
      return q ?? group.sectionTitle;
    }
    case 'unknown':
    default:
      return null;
  }
}

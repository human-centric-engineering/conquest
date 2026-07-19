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
 * The one exception to keying on the target is drafted new questions, which are split into their own
 * group by op — see {@link GAP_GROUP_KEY} for why grouping those by target actively misleads.
 *
 * Pure — findings in, groups out. No React, no Prisma, no fetching.
 */

import type { EvaluationDimension, ProposedEdit } from '@/lib/app/questionnaire/evaluation';
import type {
  EvaluationFindingView,
  FindingTargetKind,
  FindingTargetView,
} from '@/lib/app/questionnaire/views';

/**
 * The synthetic group every `add_question` finding lands in, whatever it targets.
 *
 * The Coverage judge's job is naming *gaps* — things the goal calls for that no question asks — and
 * a gap has no question to attach to, so the judge prompt tells it to target the literal `goal`
 * (`judge-prompt.ts`). Grouped by target that puts drafted new questions under a heading reading
 * "Questionnaire goal", which is the opposite of what they are: not a judgement about the goal
 * text, but questions that don't exist yet. So they are split out by *op* rather than by target — a
 * drafted question isn't about its target at all, it's about the questionnaire's missing coverage.
 *
 * The `gap:` prefix mirrors the `section:<title>` target-key convention, so it cannot collide with a
 * question key (those are bare snake_case slugs).
 */
const GAP_GROUP_KEY = 'gap:new-questions';
const GAP_GROUP_LABEL = 'Questions not yet asked';

/** The op that will actually run: the admin's edit wins over the judge's draft, as at apply. */
function effectiveOp(finding: EvaluationFindingView): ProposedEdit | null {
  return finding.editedOverride ?? finding.proposedEdit;
}

/** Whether a finding drafts a new question rather than judging an existing part of the structure. */
function isGap(finding: EvaluationFindingView): boolean {
  return effectiveOp(finding)?.op === 'add_question';
}

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
  /** The answer type when `kind === 'question'` (raw stored value); `null` otherwise. */
  questionType: string | null;
  /** The target no longer exists in the live structure (named from the run's snapshot). */
  removed: boolean;
  /**
   * This group holds drafted new questions ({@link GAP_GROUP_KEY}) rather than judgements about an
   * existing target — so the UI can title it as gaps and never imply the goal is being edited.
   */
  gap: boolean;
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

/**
 * Gaps sit between the version-level targets and the structure itself: they are questionnaire-wide
 * like the goal, but they are proposed *additions*, so they read after the framing and before the
 * per-question work.
 */
const GAP_RANK = 1.5;

function groupRank(group: FindingGroup): number {
  return group.gap ? GAP_RANK : KIND_RANK[group.kind];
}

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
  const rank = groupRank(a) - groupRank(b);
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
    // Drafted questions group by what they *are*, not what they were addressed to — see
    // GAP_GROUP_KEY. Everything else groups by its resolved target.
    const gap = isGap(finding);
    const key = gap ? GAP_GROUP_KEY : (target?.key ?? finding.targetKey);

    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        kind: gap ? 'goal' : (target?.kind ?? 'unknown'),
        label: gap ? GAP_GROUP_LABEL : (target?.label ?? finding.targetKey),
        sectionTitle: gap ? null : (target?.sectionTitle ?? null),
        sectionPosition: gap ? null : (target?.sectionPosition ?? null),
        position: gap ? null : (target?.position ?? null),
        // A gap has no answer type to show: the drafted type lives on each finding's op, and the
        // group may hold several drafts with different types.
        questionType: gap ? null : (target?.questionType ?? null),
        removed: gap ? false : (target?.removed ?? false),
        gap,
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
  // Checked before `kind`: a gap group carries kind 'goal' (that is where the judge addressed it)
  // but must never be labelled "Goal" — nothing in it edits the goal.
  if (group.gap) return group.counts.total === 1 ? 'Coverage gap' : 'Coverage gaps';

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

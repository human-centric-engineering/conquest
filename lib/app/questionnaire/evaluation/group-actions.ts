/**
 * What the panel is actually asking you to DO about one question.
 *
 * `groupFindingsByTarget` answers "which question, and who flagged it". This answers the next
 * question, the one a reviewer is really holding: *and what am I supposed to do about it* — reword
 * it, move it, change its answer type, delete it?
 *
 * That verb is currently buried. It lives in each finding's structured `proposedEdit`, one card
 * down, and a reviewer working through a long queue has to open every question and read three or
 * four suggestions before learning that all three judges were asking for the same thing.
 *
 * ## Never manufacture a consensus
 *
 * The rule this module is built around: judges disagree, and the disagreement is information. When
 * two judges want a rewrite and one wants the question deleted, that is not "reword" — it is
 * "reword (2), and one judge says delete it", and the reviewer needs both halves to decide. So the
 * primary action is the one with the most judges behind it, every dissenting action is kept and
 * returned alongside it, and {@link GroupActionSummary.contested} says plainly that the panel did
 * not agree.
 *
 * Ties break by **consequence**, not by alphabet or discovery order: when one judge says delete and
 * one says reword, the deletion leads. Not because it is more likely to be right, but because it is
 * the harder change to undo, and a reviewer skimming a collapsed card should never be surprised
 * later by a deletion that a tie hid from them.
 *
 * Pure — findings in, verbs out. No React, no Prisma, no fetching.
 */

import type { EvaluationDimension, ProposedEdit } from '@/lib/app/questionnaire/evaluation/types';
import type { EvaluationFindingView } from '@/lib/app/questionnaire/views';
import { effectiveOp, type FindingGroup } from '@/lib/app/questionnaire/evaluation/group-findings';

/**
 * The verbs a reviewer chooses between. `review` is the honest fallback for a prose-only finding:
 * the judge described a change but attached no applicable op, so there is no one-click verb — and
 * saying "review" is better than inventing a stronger one from prose we have not parsed.
 */
export const GROUP_ACTION_KINDS = [
  'delete',
  'retype',
  'split',
  'move',
  'reword',
  'guidance',
  'add',
  'goal',
  'audience',
  'review',
] as const;

export type GroupActionKind = (typeof GROUP_ACTION_KINDS)[number];

/**
 * Consequence order, most drastic first — the tiebreak when two actions have equal judge backing.
 *
 * Deleting a question destroys authored work and any answers already mapped to it; changing its
 * type invalidates its config; moving it changes the respondent's path; rewording leaves the
 * question in place. `review` sits last: it is the absence of a proposed op, so it must never
 * outrank an action a judge actually proposed.
 */
const CONSEQUENCE: Record<GroupActionKind, number> = {
  delete: 0,
  retype: 1,
  // Above `move` and well above `reword`: a split changes the SHAPE of the instrument — one
  // question becomes two, so coverage arithmetic, completion and any cohort comparison all move
  // with it. It is not as drastic as destroying authored work or invalidating a config, which is
  // why it sits below delete and retype.
  split: 2,
  move: 3,
  add: 4,
  goal: 5,
  audience: 6,
  reword: 7,
  guidance: 8,
  review: 9,
};

/** Short verb phrases. Imperative — this is a thing to do, not a category the finding belongs to. */
const ACTION_LABELS: Record<GroupActionKind, string> = {
  delete: 'Delete this question',
  retype: 'Change the answer type',
  split: 'Split it into two questions',
  move: 'Move it',
  reword: 'Reword it',
  guidance: 'Revise the guidance',
  add: 'Add a question',
  goal: 'Revise the goal',
  audience: 'Revise the audience',
  // Reads as a verb in both positions it appears: as a headline ("Review it") and inside the
  // dissent line ("1 judge says review it instead"), where a bare "Review" scans as a noun.
  review: 'Review it',
};

/**
 * The same verbs as nouns, for use as a **section heading** over one proposed action.
 *
 * The verdict used to be a single sentence — "Reword it · 2 of 3 judges · 1 judge says delete it
 * instead" — which packs the whole panel into one line and asks the reader to parse three clauses
 * before knowing what is on the table. As headings over separate blocks the imperative form reads
 * as an instruction the reader is being given ("Reword it") rather than as a label for the thing
 * being described, so each verb gets a noun: "A reword, as proposed by 2 of 3 judges".
 */
export const ACTION_NOUNS: Record<GroupActionKind, string> = {
  delete: 'A deletion',
  retype: 'A change of answer type',
  split: 'A split into two questions',
  move: 'A move',
  reword: 'A reword',
  guidance: 'New author guidance',
  add: 'A new question',
  goal: 'A revised goal',
  audience: 'A revised audience',
  // No op was proposed, so there is nothing to name but the reading itself.
  review: 'A judgement to read',
};

/** Map one structured op to its verb. A `null` op is prose-only — a judgement with no one-click fix. */
function actionForOp(op: ProposedEdit | null): GroupActionKind {
  if (!op) return 'review';
  switch (op.op) {
    case 'delete_question':
      return 'delete';
    case 'change_type':
      return 'retype';
    case 'reorder':
      return 'move';
    case 'replace_prompt':
      return 'reword';
    case 'split_question':
      return 'split';
    case 'edit_guidelines':
      return 'guidance';
    case 'add_question':
      return 'add';
    case 'edit_goal':
      return 'goal';
    case 'edit_audience':
      return 'audience';
  }
}

/** One proposed action and the judges behind it. */
export interface GroupAction {
  kind: GroupActionKind;
  /** Imperative label — "Delete this question", "Reword it". */
  label: string;
  /** Judges proposing it, first-seen order. Distinct: one judge saying it twice is one voice. */
  judges: EvaluationDimension[];
  /** Findings proposing it, so the UI can scroll to (or count) the underlying detail. */
  findings: EvaluationFindingView[];
}

/** What the panel wants done about one target, and whether it agreed. */
export interface GroupActionSummary {
  /** The best-supported action; `null` only when the group has no findings at all. */
  primary: GroupAction | null;
  /** Every other proposed action, best-supported first — the dissent, kept rather than flattened. */
  others: GroupAction[];
  /**
   * More than one distinct action was proposed. The reviewer is being asked to arbitrate, and the
   * UI should say so rather than showing the winner alone and implying a verdict.
   */
  contested: boolean;
  /** Distinct judges across the whole group — "3 of 7 judges flagged this". */
  judgeCount: number;
}

/**
 * Reduce a group's findings to the action(s) the panel proposes.
 *
 * Sorted by judge count, then by {@link CONSEQUENCE}, then by first appearance — a total order, so
 * the same run always renders the same headline rather than shuffling between reloads.
 */
export function summariseGroupActions(group: FindingGroup): GroupActionSummary {
  const byKind = new Map<GroupActionKind, GroupAction>();
  const firstSeen = new Map<GroupActionKind, number>();

  group.findings.forEach((finding, index) => {
    const kind = actionForOp(effectiveOp(finding));
    let action = byKind.get(kind);
    if (!action) {
      action = { kind, label: ACTION_LABELS[kind], judges: [], findings: [] };
      byKind.set(kind, action);
      firstSeen.set(kind, index);
    }
    action.findings.push(finding);
    // Judges, not findings: one judge raising the same fix twice is still one voice for it.
    if (!action.judges.includes(finding.dimension)) action.judges.push(finding.dimension);
  });

  const ranked = [...byKind.values()].sort((a, b) => {
    if (b.judges.length !== a.judges.length) return b.judges.length - a.judges.length;
    if (CONSEQUENCE[a.kind] !== CONSEQUENCE[b.kind])
      return CONSEQUENCE[a.kind] - CONSEQUENCE[b.kind];
    return (firstSeen.get(a.kind) ?? 0) - (firstSeen.get(b.kind) ?? 0);
  });

  return {
    primary: ranked[0] ?? null,
    others: ranked.slice(1),
    contested: ranked.length > 1,
    judgeCount: group.dimensions.length,
  };
}

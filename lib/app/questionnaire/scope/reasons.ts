/**
 * Why an area is in THIS respondent's interview, in words written for them (F17.33).
 *
 * Conditional Topics decides what a respondent is asked, and it decides it partway through: the
 * plan lands when the opening completes, and an amendment can add an area later still. On the
 * respondent's screen that is not an abstraction — whole groups appear in the panel beside the
 * conversation, minutes after they started answering.
 *
 * The interviewer's announcement covers the moment it happens and then scrolls away. The panel does
 * not: it is still showing those areas an hour later, to someone who may no longer remember being
 * told. So the reason has to live on the plan and travel with the area, not only in the transcript.
 *
 * This module is the join — plan + topics → "which keys are here because of a conditional decision,
 * and what do we say about each". Pure, so the wording rules are testable without a database.
 *
 * **Only conditional topics produce a reason.** The always-run phases were in scope from the first
 * turn: nothing appeared, so there is nothing to explain, and captioning them would turn a normal
 * questionnaire into one that looks like it is constantly justifying itself.
 */

import { plannedMembers } from '@/lib/app/questionnaire/scope/resolve';
import type { InterviewPlan, Topic } from '@/lib/app/questionnaire/scope/types';

/** Per-key reasons for one session's plan, ready for the panel to attach. */
export interface RespondentReasons {
  /** Question key → the line to show. Only keys belonging to a seated CONDITIONAL topic appear. */
  byQuestionKey: ReadonlyMap<string, string>;
  /** Data-slot key → the line to show. Same rule. */
  byDataSlotKey: ReadonlyMap<string, string>;
}

const EMPTY: RespondentReasons = { byQuestionKey: new Map(), byDataSlotKey: new Map() };

/**
 * Build the per-key reason maps for a session.
 *
 * Members are resolved through `plannedMembers`, exactly as scope is, so a `light` topic captions
 * the two items it actually contributes rather than every item it holds — a caption on a question
 * the respondent will never see is a caption nobody can act on, and it would disagree with the
 * panel beside it about what this interview contains.
 *
 * A key claimed by more than one seated topic keeps the FIRST reason, in plan order. The plan is
 * ordered best-first, so the winner is the topic that most explains why the key is here; and two
 * captions on one row is not a thing the panel can render anyway.
 */
export function respondentReasons(input: {
  plan: InterviewPlan | null;
  topics: readonly Topic[];
  weightByQuestionKey?: ReadonlyMap<string, number>;
  weightByDataSlotKey?: ReadonlyMap<string, number>;
}): RespondentReasons {
  if (!input.plan) return EMPTY;

  const byKey = new Map(input.topics.map((t) => [t.key, t]));
  const byQuestionKey = new Map<string, string>();
  const byDataSlotKey = new Map<string, string>();

  for (const planned of input.plan.topics) {
    const topic = byKey.get(planned.key);
    // Unresolvable keys are skipped everywhere in this feature; an always-run topic is skipped
    // because nothing about it appeared.
    if (!topic || topic.phase !== 'conditional') continue;

    // A plan written before reasons existed has none. Nothing is captioned rather than something
    // invented — a made-up explanation for a real decision is worse than no explanation.
    const reason = planned.respondentReason?.trim();
    if (!reason) continue;

    for (const key of plannedMembers(
      topic.members.questionKeys,
      planned.members?.questionKeys,
      planned.depth,
      input.weightByQuestionKey
    )) {
      if (!byQuestionKey.has(key)) byQuestionKey.set(key, reason);
    }
    for (const key of plannedMembers(
      topic.members.dataSlotKeys,
      planned.members?.dataSlotKeys,
      planned.depth,
      input.weightByDataSlotKey
    )) {
      if (!byDataSlotKey.has(key)) byDataSlotKey.set(key, reason);
    }
  }

  return { byQuestionKey, byDataSlotKey };
}

/**
 * The one reason a whole GROUP shares, or `null` when it does not have one.
 *
 * The panel prefers a single line under a group heading to a caption on every row: a group that
 * appeared as a unit is what the respondent actually noticed, and repeating the same sentence six
 * times reads as a warning rather than an explanation.
 *
 * Requires every member to carry the SAME reason. A group that mixes — some rows always asked, some
 * added by the plan — has no single true statement to make about itself, so it makes none and the
 * rows caption themselves.
 */
export function sharedReason(reasons: ReadonlyArray<string | null>): string | null {
  if (reasons.length === 0) return null;
  const [first] = reasons;
  if (!first) return null;
  return reasons.every((r) => r === first) ? first : null;
}

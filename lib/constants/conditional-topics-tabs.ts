/**
 * The Conditional Topics tab's three sub-tabs (F17.26).
 *
 * The surface is ~5,700 lines across 18 components and was rendered as one unbroken vertical
 * stack **ordered by the runtime pipeline** — proposer, then verification, then the topic list an
 * admin edits most, last. Split here by the **job** instead: group the questions, pin the rules and
 * limits, then check what it would do.
 *
 * Pure data. No React, no Prisma — the same shape `lib/constants/knowledge.ts` uses, so the shell,
 * the issue strip and the tests all read one definition.
 */

import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';

export const CONDITIONAL_TOPICS_TABS = ['topics', 'rules', 'check'] as const;
export type ConditionalTopicsTab = (typeof CONDITIONAL_TOPICS_TABS)[number];

export const DEFAULT_CONDITIONAL_TOPICS_TAB: ConditionalTopicsTab = 'topics';

/**
 * Visible labels.
 *
 * "Rules & limits" rather than "Settings": the tab bar above already has a Settings tab for the
 * whole version, and two things called Settings on one screen is the kind of collision an admin
 * resolves by clicking both.
 */
export const CONDITIONAL_TOPICS_TAB_LABELS: Record<ConditionalTopicsTab, string> = {
  topics: 'Topics',
  rules: 'Limits & fallbacks',
  check: 'Check',
};

/** One line under each tab's heading, saying what the tab is for. */
export const CONDITIONAL_TOPICS_TAB_HINTS: Record<ConditionalTopicsTab, string> = {
  topics: 'Group the questions, then decide which groups are conditional.',
  rules: 'Set how much one interview may cover, and what happens when the agent cannot decide.',
  check: 'Try the decision before anyone answers, and see what it did afterwards.',
};

/**
 * Where each coherence finding is fixed.
 *
 * The issue strip lives above the tab bar and its rows have to land somewhere. `ScopeIssue` carries
 * no anchor — only a `code` and an optional `topicKey` — so this is the mapping, written once here
 * rather than inferred from the code string at the call site.
 *
 * **`DEFAULT_CONDITIONAL_TOPICS_TAB` is the fallback on purpose.** `validateConditionalTopics` has 23 codes
 * today and gains more; a `Record<Code, Tab>` would make every new finding a compile error in a
 * file the author of that finding has no reason to open, and the honest default — the tab that owns
 * the topic set — is right for most of them.
 */
const TAB_BY_ISSUE_CODE: Readonly<Record<string, ConditionalTopicsTab>> = {
  // Fixed by editing a topic: its members, its phase, its criteria, its depth.
  orphaned_questions: 'topics',
  orphaned_data_slots: 'topics',
  empty_topic: 'topics',
  conditional_without_criteria: 'topics',
  duplicate_membership: 'topics',
  no_opening_topic: 'topics',
  no_conditional_topics: 'topics',
  light_depth_on_always_topic: 'topics',
  // F17.31a. `trigger_settled_at_opening` is not fixable at all — it reports what the questionnaire
  // asked for against what the product does — but the topic is where its story is, so that is where
  // the row points. The other two are mis-reads an admin corrects on the topic itself.
  trigger_settled_at_opening: 'topics',
  trigger_on_always_topic: 'topics',
  // Reserved, not currently raised: `validate.ts` stopped emitting it because no admin surface can
  // supply a cue. The mapping stays because the mid-interview-trigger spec raises it as an error
  // once something reads cues, and it belongs on the same tab when it comes back.
  trigger_without_cues: 'topics',

  // Fixed in the settings: a limit, or a list of keys.
  cap_exceeds_candidates: 'rules',
  budget_below_floor: 'rules',
  budget_admits_no_topic: 'rules',
  opening_probe_limit_inert: 'rules',
  opening_probe_limit_moot: 'rules',
  check_topic_impossible: 'rules',
  check_preference_unknown_topic: 'rules',
  fallback_unknown_topic: 'rules',
  always_topic_named_as_choice: 'rules',
};

/** The tab that owns a finding. Unknown codes land on the topic set — see the note above. */
export function tabForScopeIssue(issue: Pick<ScopeIssue, 'code'>): ConditionalTopicsTab {
  return TAB_BY_ISSUE_CODE[issue.code] ?? DEFAULT_CONDITIONAL_TOPICS_TAB;
}

/** Narrow an untrusted `?tab=` value. Anything unrecognised falls back rather than throwing. */
export function narrowConditionalTopicsTab(value: string | null | undefined): ConditionalTopicsTab {
  return (CONDITIONAL_TOPICS_TABS as readonly string[]).includes(value ?? '')
    ? (value as ConditionalTopicsTab)
    : DEFAULT_CONDITIONAL_TOPICS_TAB;
}

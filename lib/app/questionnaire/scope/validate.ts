/**
 * Adaptive Scope coherence checks (P17) — pure.
 *
 * Saving an incoherent topic set is allowed: an admin mid-edit routinely has one, and a surface
 * that refuses the save is a surface they fight. These checks run on READ instead — on the Topics
 * page and in the launch checklist — so problems are visible where they can be fixed rather than
 * blocking the keystroke that created them.
 *
 * The severity split is the whole point:
 *
 * - **`error`** — turning this on would make the questionnaire behave wrongly. The orphaned-question
 *   check is the one that matters: with scope active, a question belonging to no topic can never be
 *   asked, and nothing else in the system would ever tell you.
 * - **`warning`** — it will run, but not as the author probably intends.
 *
 * Every check is inert while `enabled` is false, except the orphan check, which is reported as a
 * warning then — it is exactly what an admin needs to see BEFORE they flip the switch.
 */

import {
  ALWAYS_PHASES,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';

/** How badly a finding bites. */
export type ScopeIssueSeverity = 'error' | 'warning';

/** One coherence finding, ready to render. */
export interface ScopeIssue {
  severity: ScopeIssueSeverity;
  /** Stable slug for the finding type — lets the UI group and the tests assert without prose. */
  code: string;
  /** One sentence, addressed to the admin. */
  message: string;
  /** The topic key the finding is about, when it is about one. */
  topicKey?: string;
}

export interface ValidateScopeInput {
  topics: readonly Topic[];
  settings: AdaptiveScopeSettings;
  /** Every question key in the version — for the orphan check. */
  allQuestionKeys: readonly string[];
  /** Every data-slot key in the version — for the rule and orphan checks. */
  allDataSlotKeys?: readonly string[];
}

/**
 * Check a version's Adaptive Scope setup. Returns findings ordered errors-first.
 *
 * Pure and total: never throws, and an empty result means "nothing to say", not "not checked".
 */
export function validateAdaptiveScope(input: ValidateScopeInput): ScopeIssue[] {
  const { topics, settings } = input;
  const issues: ScopeIssue[] = [];
  const topicKeys = new Set(topics.map((t) => t.key));

  // ── The orphan check ───────────────────────────────────────────────────────────────────────
  // Reported whether or not the feature is on, because it is precisely what an admin needs to see
  // BEFORE flipping the switch — afterwards, the symptom is a question that silently never appears.
  const covered = new Set<string>();
  for (const topic of topics) {
    for (const key of topic.members.questionKeys) covered.add(key);
  }
  const orphans = input.allQuestionKeys.filter((k) => !covered.has(k));
  if (orphans.length > 0 && topics.length > 0) {
    issues.push({
      severity: settings.enabled ? 'error' : 'warning',
      code: 'orphaned_questions',
      message: settings.enabled
        ? `${orphans.length} question${orphans.length === 1 ? '' : 's'} belong to no topic, so ${orphans.length === 1 ? 'it is' : 'they are'} never asked while Adaptive Scope is on. Add ${orphans.length === 1 ? 'it' : 'them'} to a topic.`
        : `${orphans.length} question${orphans.length === 1 ? '' : 's'} belong to no topic. That is harmless today, but ${orphans.length === 1 ? 'it' : 'they'} would never be asked if you turn Adaptive Scope on.`,
    });
  }

  const orphanSlots = (input.allDataSlotKeys ?? []).filter((k) => {
    for (const topic of topics) if (topic.members.dataSlotKeys.includes(k)) return false;
    return true;
  });
  if (orphanSlots.length > 0 && topics.length > 0) {
    issues.push({
      severity: settings.enabled ? 'error' : 'warning',
      code: 'orphaned_data_slots',
      message: `${orphanSlots.length} data slot${orphanSlots.length === 1 ? '' : 's'} belong to no topic, so the conversation would never target ${orphanSlots.length === 1 ? 'it' : 'them'} while Adaptive Scope is on.`,
    });
  }

  // ── Per-topic checks ──────────────────────────────────────────────────────────────────────
  for (const topic of topics) {
    if (topic.members.questionKeys.length === 0 && topic.members.dataSlotKeys.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'empty_topic',
        topicKey: topic.key,
        message: `"${topic.label}" contains no questions or data slots, so selecting it would do nothing.`,
      });
    }
    if (topic.phase === 'conditional' && !topic.criteria?.trim()) {
      issues.push({
        severity: settings.enabled ? 'error' : 'warning',
        code: 'conditional_without_criteria',
        topicKey: topic.key,
        message: `"${topic.label}" is conditional but has no "include this when…" criteria, so the agent has nothing to judge it on.`,
      });
    }
  }

  // ── Whole-setup checks, only meaningful once the feature is on ────────────────────────────
  if (settings.enabled) {
    if (!topics.some((t) => t.phase === 'opening')) {
      issues.push({
        severity: 'error',
        code: 'no_opening_topic',
        message:
          'No topic is marked as the opening, so nothing gathers the signal the agent needs before it can choose. Mark the topic that asks the opening questions.',
      });
    }
    if (!topics.some((t) => t.phase === 'conditional')) {
      issues.push({
        severity: 'warning',
        code: 'no_conditional_topics',
        message:
          'No topic is conditional, so every respondent gets the same questionnaire and Adaptive Scope has nothing to decide.',
      });
    }
    const conditionalCount = topics.filter((t) => t.phase === 'conditional').length;
    if (conditionalCount > 0 && settings.maxConditionalTopics >= conditionalCount) {
      issues.push({
        severity: 'warning',
        code: 'cap_exceeds_candidates',
        message: `You allow up to ${settings.maxConditionalTopics} conditional topics but only have ${conditionalCount}, so every one is always selected. Lower the limit to make the choice meaningful.`,
      });
    }
    if (settings.includeCheckTopic && conditionalCount < 2) {
      issues.push({
        severity: 'warning',
        code: 'check_topic_impossible',
        message:
          'The blind-spot check needs a conditional topic that was NOT selected to sample from, and there are too few to leave one out.',
      });
    }
  }

  // ── Dangling key references ───────────────────────────────────────────────────────────────
  const dataSlotKeys = input.allDataSlotKeys ? new Set(input.allDataSlotKeys) : null;
  for (const rule of settings.rules) {
    if (!topicKeys.has(rule.topicKey)) {
      issues.push({
        severity: 'warning',
        code: 'rule_unknown_topic',
        message: `A rule points at the topic "${rule.topicKey}", which no longer exists. It can never match.`,
      });
    }
    if (dataSlotKeys && !dataSlotKeys.has(rule.dataSlotKey)) {
      issues.push({
        severity: 'warning',
        code: 'rule_unknown_data_slot',
        message: `A rule tests the data slot "${rule.dataSlotKey}", which no longer exists. It can never match.`,
      });
    }
  }
  for (const key of settings.fallbackTopicKeys) {
    if (!topicKeys.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'fallback_unknown_topic',
        message: `The fallback names the topic "${key}", which no longer exists.`,
      });
    }
  }
  for (const key of settings.checkTopicPreference) {
    if (!topicKeys.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'check_preference_unknown_topic',
        message: `The blind-spot preference names the topic "${key}", which no longer exists.`,
      });
    }
  }
  // An always-run topic named as a fallback or blind-spot check is a no-op: both mechanisms choose
  // among CONDITIONAL topics, and one that always runs is never available to be chosen.
  const alwaysKeys = new Set(
    topics.filter((t) => ALWAYS_PHASES.includes(t.phase)).map((t) => t.key)
  );
  for (const key of [...settings.fallbackTopicKeys, ...settings.checkTopicPreference]) {
    if (alwaysKeys.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'always_topic_named_as_choice',
        topicKey: key,
        message: `"${key}" always runs, so naming it as a fallback or blind-spot check has no effect.`,
      });
    }
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** True when nothing would behave wrongly. Convenience for the launch checklist. */
export function hasScopeErrors(issues: readonly ScopeIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

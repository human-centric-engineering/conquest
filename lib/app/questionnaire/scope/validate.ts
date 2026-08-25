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
 * - **`error`** — turning this on would make the questionnaire behave wrongly. Two matter most: the
 *   orphaned-question check (with scope active, a question belonging to no topic can never be asked,
 *   and nothing else in the system would ever tell you) and `rule_veto_always_fires` (a hard rule
 *   testing for the absence of something the opening never gathers is not inert — it applies to
 *   every respondent).
 * - **`warning`** — it will run, but not as the author probably intends.
 *
 * Every check is inert while `enabled` is false, except three that an admin needs to see BEFORE
 * they flip the switch: the orphan check (reported as a warning then), the duplicate-membership
 * check (whose effect on the time arithmetic is visible either way), and the comparability checks
 * in `comparability.ts` — "what would routing do to my scores" is a question that must be answered
 * before the routing starts, not after a cohort report comes back empty.
 */

import { routedAllowanceSeconds } from '@/lib/app/questionnaire/scope/budget';
import { checkScaleComparability } from '@/lib/app/questionnaire/scope/comparability';
import {
  ALWAYS_PHASES,
  LIGHT_DEPTH_MEMBER_COUNT,
  type AdaptiveScopeSettings,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { ScoringSchemaContent } from '@/lib/app/questionnaire/scoring/types';

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
  /**
   * The time arithmetic (C7), when the caller has it: what the always-run phases cost, and the
   * cheapest routed topic. Optional because this module is pure and pricing needs question types —
   * a caller without them still gets every other finding.
   */
  seconds?: {
    always: number;
    /** The cheapest conditional topic at full depth, or 0 when there are none. */
    cheapestConditional: number;
    /**
     * Full-depth cost per topic key — what the comparability checks price a scale's topics with
     * (F17.15). Optional beside the two totals because a caller that only needs the floor
     * arithmetic should not have to carry the whole map.
     */
    byTopicKey?: Readonly<Record<string, number>>;
  };
  /**
   * The version's scoring schema, when it has one — for the comparability checks (F17.15).
   *
   * Optional, and its absence means "this version does not score", not "do not check": a caller
   * without it gets every other finding, exactly as with `seconds`.
   */
  scoring?: ScoringSchemaContent;
  /**
   * The version's per-slot re-ask cap (`maxDataSlotAttempts`), when the caller has it — for the
   * opening follow-up checks (G03).
   *
   * It lives in a different config blob from Adaptive Scope, which is exactly why it is worth
   * checking: an author rationing the opening's follow-ups has no way to see that the interview
   * does not ask any. Optional, like `seconds` and `scoring` — a caller without it gets every
   * other finding.
   */
  maxDataSlotAttempts?: number;
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
    // Light depth on a topic EVERYONE gets does not sample — it deletes. `membersAtDepth`
    // (scope/resolve.ts) applies depth to every phase, not just conditional ones, so the members it
    // drops from an always-run topic are asked of nobody. Reported regardless of `enabled` for the
    // same reason as the orphan check: before the switch this is advice, after it is a defect.
    //
    // Counted PER KIND because that is how `membersAtDepth` is applied — questions and data slots
    // are each trimmed to LIGHT_DEPTH_MEMBER_COUNT separately (see graph.ts, "up to two of EACH
    // kind"). A topic small enough that light and full are the same run is not a finding: the
    // resolver early-returns on it, so flagging it would be noise on a setting that changed nothing.
    if (ALWAYS_PHASES.includes(topic.phase) && topic.depth === 'light') {
      const droppedQuestions = Math.max(
        0,
        topic.members.questionKeys.length - LIGHT_DEPTH_MEMBER_COUNT
      );
      const droppedSlots = Math.max(
        0,
        topic.members.dataSlotKeys.length - LIGHT_DEPTH_MEMBER_COUNT
      );
      if (droppedQuestions > 0 || droppedSlots > 0) {
        const asked = Math.min(topic.members.questionKeys.length, LIGHT_DEPTH_MEMBER_COUNT);
        const total = topic.members.questionKeys.length;
        issues.push({
          severity: settings.enabled ? 'error' : 'warning',
          code: 'light_depth_on_always_topic',
          topicKey: topic.key,
          message:
            topic.phase === 'opening'
              ? `"${topic.label}" is the opening, but it is set to Light depth — so it asks only ${asked} of its ${total} questions. The opening is what the agent works out the rest of the interview from, so sampling it means deciding what to ask from half the answers. Set it to Full depth.`
              : `"${topic.label}" is asked of everyone, but it is set to Light depth — so ${droppedQuestions > 0 ? `${droppedQuestions} of its ${total} questions are` : 'some of its data slots are'} never asked, of anyone. Set it to Full depth, or move what you do not need into a conditional topic.`,
        });
      }
    }
  }

  // ── Duplicate membership ──────────────────────────────────────────────────────────────────
  // Tolerated at runtime — a question claimed by two topics is asked if EITHER is in scope, and
  // attributed to the first in-scope topic in ordinal order — but an author almost never means it,
  // and it is not free: `estimateTopicCosts` prices each topic independently and `alwaysTopicSeconds`
  // sums them, so a shared member is charged once per claiming topic. The floor comes out too high,
  // the routed allowance too low, and topics get dropped from a fit that would in fact have held
  // them. Reported regardless of `enabled` for exactly that reason: the cost panel is wrong today.
  for (const [kind, field] of [
    ['question', 'questionKeys'],
    ['data slot', 'dataSlotKeys'],
  ] as const) {
    const claimedBy = new Map<string, string[]>();
    for (const topic of topics) {
      // Deduped WITHIN a topic first: a membership list may legitimately carry the same key twice
      // (nothing prunes it on the AI-proposal or import paths), and counting that as two claimants
      // produces `"q1" belongs to both "Wellbeing" and "Wellbeing"`. One topic asking a question
      // twice is not the double-billing this check is about.
      for (const key of new Set(topic.members[field])) {
        const owners = claimedBy.get(key);
        if (owners) owners.push(topic.label);
        else claimedBy.set(key, [topic.label]);
      }
    }
    const duplicated = [...claimedBy.entries()].filter(([, owners]) => owners.length > 1);
    if (duplicated.length === 0) continue;
    const [firstKey, firstOwners] = duplicated[0];
    issues.push({
      severity: 'warning',
      code: 'duplicate_membership',
      message:
        duplicated.length === 1
          ? `The ${kind} "${firstKey}" belongs to both "${firstOwners[0]}" and "${firstOwners[1]}". It is asked once, but the time estimate counts it in both — so this interview is priced higher than it costs.`
          : `${duplicated.length} ${kind}s belong to more than one topic (including "${firstKey}", in "${firstOwners[0]}" and "${firstOwners[1]}"). Each is asked once, but the time estimate counts it in every topic that claims it — so this interview is priced higher than it costs.`,
    });
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
    // ── The time budget (C7) ───────────────────────────────────────────────────────────────
    // A budget that cannot cover the mandatory floor is not a tight interview, it is a broken one:
    // no routed topic can ever be seated, and the symptom is an instrument that quietly stops
    // adapting. Reported as an ERROR because there is no configuration in which it is what the
    // author meant.
    const budget = settings.sessionBudgetSeconds;
    if (budget > 0 && input.seconds) {
      const { always, cheapestConditional } = input.seconds;
      if (always >= budget) {
        issues.push({
          severity: 'error',
          code: 'budget_below_floor',
          message: `The questions every respondent gets already take about ${always}s, which is at or over your ${budget}s budget. No conditional topic can ever fit, so the interview would never adapt.`,
        });
      } else if (cheapestConditional > 0 && budget - always < cheapestConditional) {
        issues.push({
          severity: 'warning',
          code: 'budget_admits_no_topic',
          message: `After the questions every respondent gets (~${always}s), ${budget - always}s is left — less than your cheapest conditional topic (~${cheapestConditional}s). Every interview will run the always-on questions alone.`,
        });
      }
    }

    // ── The opening's follow-up allowance (G03) ────────────────────────────────────────────
    // Two ways to switch this on and change nothing, both invisible from the tab it is set on.
    if (settings.limitOpeningProbes) {
      // The allowance rations DATA-SLOT follow-ups: the interviewer re-asks a data slot, never a
      // form question. An opening built only from questions is therefore not rationed at all.
      const openingDataSlotKeys = topics
        .filter((t) => t.phase === 'opening')
        .flatMap((t) => t.members.dataSlotKeys);
      // Against the version's real data slots: a topic may still name a key an author deleted,
      // and a limit rationing a slot that no longer exists rations nothing.
      const known = input.allDataSlotKeys ? new Set(input.allDataSlotKeys) : null;
      const resolvable = known
        ? openingDataSlotKeys.filter((k) => known.has(k))
        : openingDataSlotKeys;
      if (resolvable.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'opening_probe_limit_inert',
          message:
            'You have limited follow-ups in the opening, but no opening topic contains a data slot — the limit applies to conversational follow-ups, so nothing is being rationed.',
        });
      } else if (input.maxDataSlotAttempts !== undefined && input.maxDataSlotAttempts <= 1) {
        issues.push({
          severity: 'warning',
          code: 'opening_probe_limit_moot',
          // The stored value, not the default it usually holds: telling an admin their setting is 1
          // when the row says 0 sends them looking for a number that is not on their screen.
          message: `You have limited follow-ups in the opening, but “attempts per data slot” is ${input.maxDataSlotAttempts} on the Settings tab, so the interview never follows up on anything and the limit can never bind.`,
        });
      }
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

  // Hard-rule reachability. Rules are evaluated at exactly ONE moment — when the opening completes
  // and the planner runs — so a rule testing a slot the interview has not gathered by then is not a
  // rule that fires later. It is a rule that never fires at all. Only the opening is reliably
  // gathered by then: `core` runs alongside it in an order nothing guarantees, and `conditional` and
  // `closing` topics are, by construction, not in scope until after the plan exists.
  //
  // Reported only when there IS an opening topic. Without one the planner runs on the first turn
  // and every rule is unreachable, which `no_opening_topic` already says once — repeating it per
  // rule buries the finding that has to be fixed first.
  const hasOpeningTopic = topics.some((t) => t.phase === 'opening');
  const openingSlotKeys = new Set<string>();
  const coreSlotKeys = new Set<string>();
  for (const topic of topics) {
    if (topic.phase === 'opening') {
      for (const key of topic.members.dataSlotKeys) openingSlotKeys.add(key);
    } else if (topic.phase === 'core') {
      for (const key of topic.members.dataSlotKeys) coreSlotKeys.add(key);
    }
  }

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
      continue;
    }
    if (!hasOpeningTopic || openingSlotKeys.has(rule.dataSlotKey)) continue;

    if (coreSlotKeys.has(rule.dataSlotKey)) {
      issues.push({
        severity: 'warning',
        code: 'rule_slot_not_in_opening',
        message: `A rule tests "${rule.dataSlotKey}", which is gathered by a topic that always runs but is not the opening. The rules are evaluated the moment the opening completes, so whether this has been asked by then is not something the rule can rely on. Move it into an opening topic.`,
      });
    } else if (rule.operator === 'not_exists') {
      // The sharp one. `not_exists` matches on ABSENCE, so a slot that is never gathered before the
      // planner runs is not an inert rule — it is one that fires for every respondent. An author
      // who wrote a veto for the few gets it applied to all, and the plan looks entirely plausible.
      issues.push({
        severity: settings.enabled ? 'error' : 'warning',
        code: 'rule_veto_always_fires',
        message: `A rule tests "${rule.dataSlotKey}" for absence, but no opening topic gathers it — so it is always absent when the rules run, and the rule would ${rule.action} "${rule.topicKey}" for every respondent. Add the slot to an opening topic.`,
      });
    } else {
      issues.push({
        severity: 'warning',
        code: 'rule_slot_unreachable',
        message: `A rule tests "${rule.dataSlotKey}", but no opening topic gathers it, so it is never filled when the rules run and the rule can never match. Add the slot to an opening topic.`,
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
  // A hard rule aimed at an always-run topic is the same no-op, reached from the other direction:
  // `applyGuardrails` acts within the conditional set, and `resolveScope` puts every other phase in
  // scope regardless. Reported separately from the check above because the fix is different — the
  // author either meant a different topic or meant to make this one conditional — and because a rule
  // is the surface where a silent no-op is most expensive: it reads as the certainty it is not.
  for (const rule of settings.rules) {
    if (!alwaysKeys.has(rule.topicKey)) continue;
    issues.push({
      severity: 'warning',
      code: 'rule_names_always_topic',
      topicKey: rule.topicKey,
      message: `A rule ${rule.action === 'include' ? 'includes' : 'excludes'} "${rule.topicKey}", but that topic is asked in every interview, so the rule changes nothing. Rules only act on topics set to "Ask when it fits".`,
    });
  }

  // ── Comparability (F17.15) ────────────────────────────────────────────────────────────────
  // Skipped only when the caller has no scoring schema to check against, which is most versions.
  if (input.scoring) {
    const byTopicKey = input.seconds?.byTopicKey;
    issues.push(
      ...checkScaleComparability({
        topics,
        settings,
        scoring: input.scoring,
        // Lets the scale checks tell a key that exists but sits in no topic (fixable here, an
        // error) from one the version no longer has at all (a stale scoring reference, a warning).
        inventory: {
          questionKeys: input.allQuestionKeys,
          dataSlotKeys: input.allDataSlotKeys ?? [],
        },
        seconds: byTopicKey
          ? {
              byTopicKey,
              routedAllowance: routedAllowanceSeconds(
                settings.sessionBudgetSeconds,
                input.seconds?.always ?? 0
              ),
            }
          : undefined,
      })
    );
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** True when nothing would behave wrongly. Convenience for the launch checklist. */
export function hasScopeErrors(issues: readonly ScopeIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

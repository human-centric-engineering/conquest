/**
 * Conditional Topics coherence checks (P17) — pure.
 *
 * Saving an incoherent topic set is allowed: an admin mid-edit routinely has one, and a surface
 * that refuses the save is a surface they fight. These checks run on READ instead — on the Topics
 * page and in the launch checklist — so problems are visible where they can be fixed rather than
 * blocking the keystroke that created them.
 *
 * The severity split is the whole point:
 *
 * - **`error`** — turning this on would make the questionnaire behave wrongly. The one that matters
 *   most is the orphaned-question check: with scope active, a question belonging to no topic can
 *   never be asked, and nothing else in the system would ever tell you.
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
  type ConditionalTopicsSettings,
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
  settings: ConditionalTopicsSettings;
  /** Every question key in the version — for the orphan check. */
  allQuestionKeys: readonly string[];
  /** Every data-slot key in the version — for the orphan check. */
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
   * It lives in a different config blob from Conditional Topics, which is exactly why it is worth
   * checking: an author rationing the opening's follow-ups has no way to see that the interview
   * does not ask any. Optional, like `seconds` and `scoring` — a caller without it gets every
   * other finding.
   */
  maxDataSlotAttempts?: number;
  /**
   * The wording behind each member key, when the caller has it — for the uncoverable-member check
   * (F17.36). Questions map to their prompt; data slots to their name and description together.
   *
   * Optional like everything else here: a caller without it gets every other finding. Passed as
   * plain records rather than Maps to match `seconds.byTopicKey`, and because the callers that
   * have this are route handlers assembling a payload, not holding a lookup.
   */
  memberText?: {
    byQuestionKey?: Readonly<Record<string, string>>;
    byDataSlotKey?: Readonly<Record<string, string>>;
  };
}

/**
 * Check a version's Conditional Topics setup. Returns findings ordered errors-first.
 *
 * Pure and total: never throws, and an empty result means "nothing to say", not "not checked".
 */
/**
 * Question keys no topic claims — the orphan set, as keys rather than a count.
 *
 * Exported because two callers need the same answer and must not compute it twice: the orphan
 * finding below, and the Topics payload's `coverage` block, which reports the number on a header
 * that is visible whether or not the issue list is. A second implementation would eventually
 * disagree with this one, and "the header says 3, the issue says 4" is the kind of contradiction
 * that makes an admin stop trusting both.
 *
 * Note this is the raw set: the finding additionally suppresses itself when the version has no
 * topics at all (nothing is authored yet, so "belongs to no topic" is not yet a mistake). A caller
 * reporting coverage wants the count regardless, and decides its own framing.
 */
export function uncoveredQuestionKeys(
  topics: readonly Topic[],
  allQuestionKeys: readonly string[]
): string[] {
  const covered = new Set<string>();
  for (const topic of topics) {
    for (const key of topic.members.questionKeys) covered.add(key);
  }
  return allQuestionKeys.filter((k) => !covered.has(k));
}

/** Data-slot equivalent of {@link uncoveredQuestionKeys}. */
export function uncoveredDataSlotKeys(
  topics: readonly Topic[],
  allDataSlotKeys: readonly string[]
): string[] {
  const covered = new Set<string>();
  for (const topic of topics) {
    for (const key of topic.members.dataSlotKeys) covered.add(key);
  }
  return allDataSlotKeys.filter((k) => !covered.has(k));
}

export function validateConditionalTopics(input: ValidateScopeInput): ScopeIssue[] {
  const { topics, settings } = input;
  const issues: ScopeIssue[] = [];
  const topicKeys = new Set(topics.map((t) => t.key));

  // ── The orphan check ───────────────────────────────────────────────────────────────────────
  // Reported whether or not the feature is on, because it is precisely what an admin needs to see
  // BEFORE flipping the switch — afterwards, the symptom is a question that silently never appears.
  const orphans = uncoveredQuestionKeys(topics, input.allQuestionKeys);
  if (orphans.length > 0 && topics.length > 0) {
    issues.push({
      severity: settings.enabled ? 'error' : 'warning',
      code: 'orphaned_questions',
      message: settings.enabled
        ? `${orphans.length} question${orphans.length === 1 ? '' : 's'} belong to no topic, so ${orphans.length === 1 ? 'it is' : 'they are'} never asked while Conditional Topics is on. Add ${orphans.length === 1 ? 'it' : 'them'} to a topic.`
        : `${orphans.length} question${orphans.length === 1 ? '' : 's'} belong to no topic. That is harmless today, but ${orphans.length === 1 ? 'it' : 'they'} would never be asked if you turn Conditional Topics on.`,
    });
  }

  const orphanSlots = uncoveredDataSlotKeys(topics, input.allDataSlotKeys ?? []);
  if (orphanSlots.length > 0 && topics.length > 0) {
    issues.push({
      severity: settings.enabled ? 'error' : 'warning',
      code: 'orphaned_data_slots',
      message: `${orphanSlots.length} data slot${orphanSlots.length === 1 ? '' : 's'} belong to no topic, so the conversation would never target ${orphanSlots.length === 1 ? 'it' : 'them'} while Conditional Topics is on.`,
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
    // F17.31a — what the document asked for, where the product settles scope once.
    //
    // A trigger is RECORDED, not run: the topic is still chosen (or not) from the opening by its
    // criteria above. So this is not a defect in the configuration — nothing here is misconfigured
    // and there is no edit that fixes it. It is the one place an admin can see, while reviewing the
    // routing, that the instrument asked for something narrower than what will happen.
    //
    // Always a warning, and reported whether or not the feature is enabled, because it describes
    // the DOCUMENT rather than the settings.
    //
    // Mutually exclusive with `trigger_on_always_topic` below. On an always-run topic this
    // message is not merely redundant, it is FALSE — it says the topic is included only when the
    // condition is clear by the end of the opening, and an always-run topic is included for
    // everyone regardless. Two warnings on one topic key that contradict each other teach an admin
    // to distrust the panel, so each trigger raises exactly one of the two.
    if (topic.trigger && !ALWAYS_PHASES.includes(topic.phase)) {
      issues.push({
        severity: 'warning',
        code: 'trigger_settled_at_opening',
        topicKey: topic.key,
        message: `The questionnaire says to add "${topic.label}" whenever this comes up: "${topic.trigger.condition}". This interview decides what to cover once, after the opening questions — so "${topic.label}" is only included when that is already clear by then, not if it first comes up later.`,
      });
    }
    // A trigger on a topic everyone is asked anyway can never do anything, whatever happens to
    // triggers later: the topic is already in scope for every respondent. Usually a mis-read of the
    // document — the block was conditional and landed on an always-run phase.
    if (topic.trigger && ALWAYS_PHASES.includes(topic.phase)) {
      issues.push({
        severity: 'warning',
        code: 'trigger_on_always_topic',
        topicKey: topic.key,
        message: `"${topic.label}" is asked of everyone, so the questionnaire's instruction to add it when something comes up can never change anything. If it should only be asked sometimes, make it conditional.`,
      });
    }
    // `trigger_without_cues` is NOT raised, and its absence is the considered position rather than
    // an oversight. It said a topic records what to watch for "but no words to listen for" — which
    // is true, and which no control on any admin surface can fix: cues are written by the analyst
    // from the document, the topic editor shows a trigger read-only, and nothing reads a cue yet.
    // A warning whose only honest response is "I know, and I cannot" teaches an admin to skim the
    // panel, which costs the warnings beside it that ARE actionable.
    //
    // The code stays registered in `conditional-topics-tabs.ts` because it has a future: the
    // mid-interview-trigger spec raises it as an ERROR once an evaluator reads cues, at which point
    // empty cues really are a defect and the fix is a re-analysis. See
    // `.context/app/planning/features/f17-mid-interview-triggers.md`.
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
        const total = topic.members.questionKeys.length;
        const asked = Math.min(total, LIGHT_DEPTH_MEMBER_COUNT);
        // Name whichever kind actually lost members. The check fires on either, so a topic whose
        // questions all fit under the floor but whose data slots do not would otherwise read
        // "asks only 1 of its 1 questions" — self-contradictory, and it points the admin at the
        // half that is fine.
        const lost =
          droppedQuestions > 0
            ? `it asks only ${asked} of its ${total} questions`
            : `${droppedSlots} of its data slots are never filled`;
        issues.push({
          severity: settings.enabled ? 'error' : 'warning',
          code: 'light_depth_on_always_topic',
          topicKey: topic.key,
          message:
            topic.phase === 'opening'
              ? `"${topic.label}" is the opening, but it is set to Light depth — so ${lost}. The opening is what the agent works out the rest of the interview from, so sampling it means deciding what to ask from part of the answers. Set it to Full depth.`
              : `"${topic.label}" is asked of everyone, but it is set to Light depth — so ${lost}, for anyone. Set it to Full depth, or move what you do not need into a conditional topic.`,
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
          'No topic is conditional, so every respondent gets the same questionnaire and Conditional Topics has nothing to decide.',
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

    // ── Opening members no respondent can ever cover (F17.36) ──────────────────────────────
    //
    // The opening gate is all-or-nothing, so ONE member nobody can cover means the plan is never
    // made — for every respondent, silently, forever. Session CPY3-1C6S was exactly this: an
    // opening topic naming a question slot that held a scripted handoff line, and a data slot
    // whose description recorded the interview's own routing decision. Neither is answerable.
    //
    // Inside the `enabled` block on purpose. The gate this is about only exists when the feature
    // is on, and warning every version that has never used Conditional Topics about the wording
    // of its opening questions would be noise on a tab that has to stay worth reading.
    //
    // Heuristic and therefore ADVISORY. It reads wording, which means it will occasionally be
    // wrong in both directions, and a wrong error would block a launch over a phrasing opinion.
    // `maxOpeningTurns` is the runtime cover for the ones this misses; this is the authoring-time
    // cover for the ones it catches, and the message says so when the backstop is off.
    const openingTopics = topics.filter((t) => t.phase === 'opening');
    const knownQuestions = input.allQuestionKeys ? new Set(input.allQuestionKeys) : null;
    const knownDataSlots = input.allDataSlotKeys ? new Set(input.allDataSlotKeys) : null;
    const uncoverable: string[] = [];

    for (const key of new Set(openingTopics.flatMap((t) => t.members.questionKeys))) {
      if (knownQuestions && !knownQuestions.has(key)) continue;
      const prompt = input.memberText?.byQuestionKey?.[key];
      if (prompt !== undefined && !asksSomething(prompt)) uncoverable.push(key);
    }
    for (const key of new Set(openingTopics.flatMap((t) => t.members.dataSlotKeys))) {
      if (knownDataSlots && !knownDataSlots.has(key)) continue;
      const text = input.memberText?.byDataSlotKey?.[key];
      if (text !== undefined && describesTheInterview(text)) uncoverable.push(key);
    }

    if (uncoverable.length > 0) {
      const backstop =
        settings.maxOpeningTurns > 0
          ? ` The opening closes itself after ${settings.maxOpeningTurns} turns, so an interview will still reach a decision — but on less than the opening was meant to gather.`
          : ' Nothing currently stops that: set “longest the opening may run” so an interview decides on what it has rather than waiting forever.';
      issues.push({
        severity: 'warning',
        code: 'opening_member_uncoverable',
        message:
          uncoverable.length === 1
            ? `“${uncoverable[0]}” is in the opening but does not look like something a respondent can answer, so the opening may never register as finished.${backstop}`
            : `${uncoverable.length} opening items (including “${uncoverable[0]}”) do not look like something a respondent can answer, so the opening may never register as finished.${backstop}`,
      });
    }
  }

  // ── Dangling key references ───────────────────────────────────────────────────────────────
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
/* -------------------------------------------------------------------------- */
/* Uncoverable-member heuristics (F17.36)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Words that open a request for something from the respondent.
 *
 * Not just interrogatives: a good interview prompt is as often an imperative ("Describe the last
 * time…", "Walk me through…") as a question, and treating those as uncoverable would flag the best
 * questions in most instruments.
 */
const ASKING_OPENERS = [
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'which',
  'whose',
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'can',
  'could',
  'would',
  'will',
  'should',
  'have',
  'has',
  'had',
  'tell',
  'describe',
  'explain',
  'list',
  'name',
  'rate',
  'rank',
  'score',
  'select',
  'choose',
  'pick',
  'share',
  'walk',
  'think',
  'consider',
  'give',
  'in',
  'on',
  'to',
  'roughly',
  'approximately',
  'briefly',
] as const;

/**
 * Whether a question prompt asks the respondent for anything at all.
 *
 * Deliberately generous: a question mark anywhere, or an opener from {@link ASKING_OPENERS},
 * passes. The finding this feeds is advisory, and the asymmetry is on purpose — a missed handoff
 * line costs an author one confusing session, while a false positive on a perfectly good question
 * costs every author who reads the tab a reason to stop trusting it.
 */
function asksSomething(prompt: string): boolean {
  const text = prompt.trim().toLowerCase();
  if (text.length === 0) return false;
  if (text.includes('?')) return true;
  const firstWord = /^[a-z']+/.exec(text)?.[0] ?? '';
  return (ASKING_OPENERS as readonly string[]).includes(firstWord);
}

/**
 * Phrases that say a data slot records the INTERVIEW'S behaviour rather than a respondent fact.
 *
 * `diagnostic_routing` on the session that produced this check described itself as recording "the
 * interviewer's routing decision" — a slot the respondent is never asked to fill, sitting in an
 * opening topic, holding every interview open forever.
 */
const SELF_DESCRIBING_CUES = [
  'the interviewer',
  "the interview's",
  'the agent',
  'the assistant',
  'the system',
  'the platform',
  'routing decision',
  'the decision this',
  'internal use',
  'internal only',
  'not asked',
  'never asked',
  'do not ask',
  'set by the',
  'recorded by the',
  'filled by the',
] as const;

/**
 * Whether a data slot's wording describes the interview rather than the respondent.
 *
 * Phrase matching, not word matching. "The agent" as a phrase is about the software; "agent" alone
 * is a job title, and an instrument for estate agents would otherwise have its whole opening
 * flagged.
 */
function describesTheInterview(text: string): boolean {
  const lower = text.toLowerCase();
  return SELF_DESCRIBING_CUES.some((cue) => lower.includes(cue));
}

export function hasScopeErrors(issues: readonly ScopeIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

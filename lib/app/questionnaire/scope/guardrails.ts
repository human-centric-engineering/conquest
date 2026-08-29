/**
 * Conditional Topics guardrails (P17) — pure.
 *
 * The deterministic layer applied AFTER the planner proposes. This ordering is the whole design:
 * **the model proposes, it never gets the last word on a hard constraint.** Six numbered rules in a
 * system prompt will be obeyed most of the time, which is the worst possible failure mode — plausible
 * plans that quietly break the limit an author set, with nothing to catch them.
 *
 * Order matters and is not arbitrary:
 *
 *  1. **Rule excludes** — an author's "never" is absolute; drop those first so nothing downstream
 *     can reinstate them.
 *  2. **Rule includes** — an author's "always" is absolute too, and must be seated BEFORE the cap
 *     so it cannot be truncated away by a model's enthusiasm.
 *  3. **The cap** — trim the model's picks to what is left of the limit.
 *  4. **The fallback** — only when steps 1–3 produced nothing at all.
 *  5. **The fit** (C7b) — drop from the bottom until what is seated costs no more than the session
 *     budget leaves. AFTER the rules, so an author's "always" is never costed away; after the
 *     fallback, so a safety net cannot smuggle in an interview nobody has time for; and BEFORE the
 *     check topic, so the check's own seconds are reserved rather than treated as free.
 *  6. **The check topic** — chosen from what did NOT make the cut, so it is always genuinely
 *     something the interview would otherwise have missed.
 *
 * Every function here is data-in/data-out and exhaustively unit-testable by hand.
 */

import {
  ALWAYS_PHASES,
  type ConditionalTopicsSettings,
  type ExcludedTopic,
  type InterviewPlan,
  type PlannedTopic,
  type TopicMembers,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { RuleOutcome } from '@/lib/app/questionnaire/scope/rules';
import {
  alwaysTopicSeconds,
  formatSeconds,
  plannedSeconds,
  routedAllowanceSeconds,
  type ItemSeconds,
  type TopicCost,
} from '@/lib/app/questionnaire/scope/budget';

/**
 * What a respondent is told when nothing better was produced (F17.33).
 *
 * Reached when the planner omitted `respondentReason`, and used verbatim for a rule-included topic
 * — a hard rule's own reason is the author's note to an admin ("include when headcount > 50"), which
 * is not a sentence to put in front of the person being interviewed.
 *
 * Says something true and unremarkable rather than apologising or explaining the mechanism. The
 * alternative that was rejected — "we could not tell why this applies to you" — is accurate and a
 * miserable thing to read about yourself.
 */
export const DEFAULT_RESPONDENT_REASON = 'Part of the ground this review covers.';

/** One topic the planner proposed, before any guardrail has touched it. */
export interface ProposedTopic {
  key: string;
  /** The planner's own account of why — kept verbatim so an admin reads the model's reasoning. */
  rationale: string;
  /**
   * The items the planner named, when it judged that only part of the topic applies (C6).
   *
   * Seated as-is minus anything the topic does not actually contain — a proposal may narrow a
   * topic, never widen it — and dropped entirely when the intersection is empty, which leaves the
   * topic's depth to decide as it always has.
   */
  members?: { questionKeys?: readonly string[]; dataSlotKeys?: readonly string[] };
  /**
   * The planner's plain-English reason for the RESPONDENT (F17.33) — what the panel shows beside
   * this area. Optional: a model that omits it gets {@link DEFAULT_RESPONDENT_REASON} rather than
   * an unexplained area on someone's screen.
   */
  respondentReason?: string;
}

/**
 * What the fit stage (C7b) needs to price a plan: the budget, and what every topic costs.
 *
 * Passed in rather than derived here because pricing needs each question's TYPE, which lives in the
 * database and this module never touches. The caller resolves it once per session with
 * `scope/budget.ts`; the arithmetic itself stays pure.
 */
export interface PlanBudget {
  /** The whole session's allowance, in seconds. `0` means no budget, and the fit does nothing. */
  budgetSeconds: number;
  /** Every topic's cost at both depths — {@link estimateTopicCosts}, over the SAME topic set. */
  costs: ReadonlyMap<string, TopicCost>;
  /**
   * Per-item seconds and weights, so a plan naming a SUBSET of a topic (C6) is priced on the items
   * it names. Optional: without them a subset is charged at its depth, which over-states rather
   * than under-states — a budget that drops one topic too many beats one that overruns.
   */
  seconds?: ItemSeconds;
  weights?: {
    byQuestionKey?: ReadonlyMap<string, number>;
    byDataSlotKey?: ReadonlyMap<string, number>;
  };
}

export interface ApplyGuardrailsInput {
  /** Every topic in the version. */
  topics: readonly Topic[];
  /** What the planner proposed, best first. Empty when it errored or chose nothing. */
  proposed: readonly ProposedTopic[];
  /** What the hard rules decided. */
  rules: RuleOutcome;
  settings: ConditionalTopicsSettings;
  /** The planner's confidence, already clamped to 0–1. */
  confidence: number;
  /** What produced `proposed` — `llm`, or `fallback` when the planner could not be trusted. */
  source: 'llm' | 'fallback';
  /** The line spoken to the respondent. Empty when announcing is off or nothing was produced. */
  respondentMessage: string;
  /** Turn ordinal the decision was taken at. */
  decidedAtTurn: number;
  /** ISO timestamp — passed in because this module has no clock. */
  decidedAt: string;
  /**
   * The session time budget and the topic prices, when the version sets one (C7b).
   *
   * Absent — which is the default and therefore most versions — means no fit stage runs and the
   * plan is exactly what it was before budgets existed. That silence is the point: enforcement
   * that switched itself on would change what every existing instrument asks.
   */
  budget?: PlanBudget;
}

/**
 * Choose the blind-spot topic: one conditional topic that did NOT make the cut, sampled lightly.
 *
 * A diagnostic that only asks about the problem the respondent already named can only confirm what
 * they already believed. Sampling one area they did not raise is what makes the result capable of
 * surprising them — which is the entire value of assessing anything.
 *
 * Preference order: the author's nominated keys (predictable), then the first unselected conditional
 * topic in authored order. Weight deliberately does NOT enter here — `fitToBudget` reserves seconds
 * for whatever this returns, so a probe that moved between runs would make the budget unpredictable
 * too. Returns null when there is nothing left to sample.
 */
export function chooseCheckTopic(
  topics: readonly Topic[],
  selected: ReadonlySet<string>,
  settings: ConditionalTopicsSettings
): Topic | null {
  if (!settings.includeCheckTopic) return null;

  const available = topics.filter((t) => t.phase === 'conditional' && !selected.has(t.key));
  if (available.length === 0) return null;

  for (const preferred of settings.checkTopicPreference) {
    const match = available.find((t) => t.key === preferred);
    if (match) return match;
  }
  // Authored order, so the same unselected set always yields the same check topic — a diagnostic
  // whose blind-spot probe moved around between runs would be impossible to reason about.
  return available[0] ?? null;
}

/**
 * Narrow a proposed member subset to what the topic actually contains (C6).
 *
 * Returns `{}` — no subset, the depth decides — when nothing was proposed, or when nothing proposed
 * survives the intersection. A planner naming items that are not in the topic is the same class of
 * mistake as naming a topic that does not exist, and gets the same treatment: the layer that exists
 * to make any input coherent quietly discards it rather than routing into nothing.
 *
 * Authored order is preserved, so a subset asks the instrument's questions in the instrument's
 * order rather than the order a model happened to list them.
 */
function seatedMembers(
  topic: Topic,
  proposed: ProposedTopic['members']
): { members?: TopicMembers } {
  if (!proposed) return {};
  const keep = (authored: readonly string[], named: readonly string[] | undefined): string[] => {
    if (!named || named.length === 0) return [];
    const wanted = new Set(named);
    return authored.filter((key) => wanted.has(key));
  };
  const questionKeys = keep(topic.members.questionKeys, proposed.questionKeys);
  const dataSlotKeys = keep(topic.members.dataSlotKeys, proposed.dataSlotKeys);
  if (questionKeys.length === 0 && dataSlotKeys.length === 0) return {};

  // A subset naming only questions leaves the topic's data slots to the depth, and vice versa —
  // narrowing one half is not a statement about the other. The un-named half is stored EMPTY
  // rather than filled with the whole authored list, because `plannedMembers` reads an empty half
  // as "the depth decides" and a full one as "ask all of these". Filling it would silently widen a
  // `light` topic from its two sampled items to every one it has — the one thing a subset must
  // never do, and the opposite of what narrowing the other half asked for.
  return { members: { questionKeys, dataSlotKeys } };
}

/**
 * Apply every guardrail to a proposal and produce the final {@link InterviewPlan}.
 *
 * Total: any input — an empty proposal, unknown keys, a cap of zero, contradictory rules — produces
 * a coherent plan. There is no failure return, because the caller is standing between a respondent
 * and their next question and has nowhere to put one.
 */
export function applyGuardrails(input: ApplyGuardrailsInput): InterviewPlan {
  const { topics, settings } = input;
  const conditional = topics.filter((t) => t.phase === 'conditional');
  const byKey = new Map(conditional.map((t) => [t.key, t]));

  const planned: PlannedTopic[] = [];
  const seen = new Set<string>();

  const seat = (
    key: string,
    source: PlannedTopic['source'],
    rationale: string,
    members?: ProposedTopic['members'],
    respondentReason?: string
  ): void => {
    if (seen.has(key)) return;
    const topic = byKey.get(key);
    // Unknown, always-run, or already-seated keys are silently skipped. A planner naming a topic
    // that does not exist is exactly what this layer is for — never route into nothing.
    if (!topic) return;
    seen.add(key);
    planned.push({
      key,
      depth: topic.depth,
      source,
      rationale,
      ...seatedMembers(topic, members),
      // F17.33: every seated topic leaves here with a respondent-facing reason. The panel shows
      // areas appearing partway through an interview, and an area that appears with no explanation
      // is what makes someone wonder what else is being decided about them. A default is a worse
      // sentence than the planner's own, and infinitely better than a blank.
      respondentReason: (respondentReason ?? '').trim() || DEFAULT_RESPONDENT_REASON,
    });
  };

  // 1 + 2. Rules first, and BEFORE the cap: an author's "always include this" must not be
  // truncated away by a model that proposed three other things it liked better.
  for (const key of input.rules.include) {
    if (input.rules.exclude.has(key)) continue;
    // The rule's own reason is written by the AUTHOR for an admin ("include when headcount > 50"),
    // so it is not offered to the respondent — the default is.
    seat(key, 'rule', input.rules.reasonByTopic.get(key) ?? 'A rule you set included this topic.');
  }

  // 3. The model's picks, in its own order, up to what remains of the limit.
  for (const proposal of input.proposed) {
    if (planned.length >= settings.maxConditionalTopics) break;
    if (input.rules.exclude.has(proposal.key)) continue;
    seat(
      proposal.key,
      input.source,
      proposal.rationale,
      proposal.members,
      proposal.respondentReason
    );
  }

  // 4. The fallback — only when nothing at all was seated. An interview of just the always-run
  // topics is coherent, if thin, so an empty fallback list is a legitimate configuration.
  let source = input.source;
  if (planned.length === 0 && settings.fallbackTopicKeys.length > 0) {
    source = 'fallback';
    for (const key of settings.fallbackTopicKeys) {
      if (planned.length >= settings.maxConditionalTopics) break;
      if (input.rules.exclude.has(key)) continue;
      seat(
        key,
        'fallback',
        'Chosen as a safe default because no clear signal was found.',
        undefined,
        // Deliberately not "we could not tell what you needed". True, and a poor thing to read
        // about yourself; the respondent-facing version says what is happening, not what failed.
        'Part of the ground this review covers.'
      );
    }
  }

  // 5. The fit (C7b) — the seconds the plan actually costs, against the seconds it may spend.
  const droppedForBudget = fitToBudget({ planned, seen, topics, settings, budget: input.budget });

  // 6. The blind-spot check, from what did NOT make the cut.
  const check = chooseCheckTopic(topics, seen, settings);
  if (check) {
    seen.add(check.key);
    planned.push({
      key: check.key,
      // Forced light regardless of how the author set it up: its job in THIS interview is to
      // sample an area the respondent did not raise, not to score it.
      depth: 'light',
      source: 'check',
      rationale:
        'Sampled as a blind-spot check — an area the respondent did not raise, so the result can ' +
        'surprise them rather than only confirm what they already believed.',
      // The one reason that may NOT be derived from what the respondent said, because the planner
      // has an absence of signal rather than evidence. "You did not raise this" is a claim about
      // them; "we have not covered it yet" is a statement about the conversation, which is true,
      // checkable, and accuses no one. See `respondentReasonFor` in `amendment.ts` and the
      // three-way naming split in conditional-topics.md.
      respondentReason:
        'A few questions on something we have not covered yet, so the picture is not one-sided.',
    });
  }

  const excluded: ExcludedTopic[] = conditional
    .filter((t) => !seen.has(t.key))
    .map((t) => {
      // A topic the budget took back is NOT "not selected". It was chosen, and then there was no
      // time for it — which is a different answer to the only question this record exists to
      // answer, and the one that points an author at the setting rather than at the agent.
      const overBudget = droppedForBudget.get(t.key);
      if (overBudget) return { key: t.key, source: 'budget' as const, rationale: overBudget };
      return {
        key: t.key,
        source: input.rules.exclude.has(t.key) ? ('rule' as const) : ('llm' as const),
        rationale:
          input.rules.reasonByTopic.get(t.key) ??
          'Not selected — nothing in the opening pointed at this area.',
      };
    });

  return {
    v: 1,
    topics: planned,
    excluded,
    checkTopicKey: check?.key ?? null,
    confidence: input.confidence,
    source,
    respondentMessage: settings.announce ? input.respondentMessage : '',
    decidedAtTurn: input.decidedAtTurn,
    decidedAt: input.decidedAt,
    // Recorded on the plan, not recomputed on read: the instrument can be edited afterwards, and a
    // figure derived from today's questions would answer a question nobody asked.
    ...(input.budget && input.budget.budgetSeconds > 0
      ? {
          budgetSeconds: input.budget.budgetSeconds,
          estimatedSeconds:
            alwaysTopicSeconds(topics, input.budget.costs) +
            plannedSeconds(planned, input.budget.costs, exactPricing(topics, input.budget)),
        }
      : {}),
  };
}

/**
 * The per-item price list `plannedSeconds` needs to cost a partial topic (C6), or `undefined` when
 * the caller did not supply one.
 */
function exactPricing(
  topics: readonly Topic[],
  budget: PlanBudget | undefined
):
  | {
      topicsByKey: ReadonlyMap<string, Topic>;
      seconds: ItemSeconds;
      weights?: {
        byQuestionKey?: ReadonlyMap<string, number>;
        byDataSlotKey?: ReadonlyMap<string, number>;
      };
    }
  | undefined {
  if (!budget?.seconds) return undefined;
  return {
    topicsByKey: new Map(topics.map((t) => [t.key, t] as const)),
    seconds: budget.seconds,
    ...(budget.weights ? { weights: budget.weights } : {}),
  };
}

/**
 * Drop the lowest-ranked topics until the plan fits the budget. Mutates `planned` and `seen`.
 *
 * Returns the reason each dropped topic was dropped, keyed by topic key — so the plan can say
 * "there was no time for this" rather than the untrue "the agent did not pick it".
 *
 * Three decisions worth stating, because each is a place a reasonable implementation differs:
 *
 * - **A rule-seated topic is never dropped.** An author's "always ask about compliance" is not a
 *   preference the arithmetic gets to overrule; if the rules alone bust the budget, the interview
 *   runs long and the settings tab has already said so (`budget_below_floor`).
 * - **The lowest-ranked goes first** — the last thing seated, which is the planner's own least
 *   confident pick, or the last fallback. The model ordered them; the budget takes them back in
 *   reverse.
 * - **The check topic's seconds are reserved before anything is judged to fit.** It is chosen from
 *   what did NOT make the cut, so its cost is not known until the drops are settled — hence the
 *   re-evaluation each pass. Treating it as free is exactly the omission the pilot client workbook's own
 *   arithmetic makes, and it is how a plan lands 14 seconds over the number it just promised.
 */
function fitToBudget(args: {
  planned: PlannedTopic[];
  seen: Set<string>;
  topics: readonly Topic[];
  settings: ConditionalTopicsSettings;
  budget: PlanBudget | undefined;
}): Map<string, string> {
  const { planned, seen, topics, settings, budget } = args;
  const dropped = new Map<string, string>();
  if (!budget || budget.budgetSeconds <= 0) return dropped;

  const exact = exactPricing(topics, budget);

  const allowance = routedAllowanceSeconds(
    budget.budgetSeconds,
    alwaysTopicSeconds(topics, budget.costs)
  );
  const reason =
    `Chosen, then dropped: the interview's ${formatSeconds(budget.budgetSeconds)} budget was ` +
    'already spent on the topics ranked above it.';

  // The blind-spot check is chosen AFTER this stage, from whatever is left over — so what it will
  // cost depends on what this loop drops, and has to be re-asked each pass.
  const reserveForCheck = (): number => {
    const check = chooseCheckTopic(topics, seen, settings);
    return check ? (budget.costs.get(check.key)?.light ?? 0) : 0;
  };

  while (plannedSeconds(planned, budget.costs, exact) + reserveForCheck() > allowance) {
    // The last droppable entry — `findLastIndex` by hand, since a rule-seated topic in the middle
    // must be stepped over rather than ending the search.
    let index = -1;
    for (let i = planned.length - 1; i >= 0; i -= 1) {
      if (planned[i]?.source !== 'rule') {
        index = i;
        break;
      }
    }
    // Nothing left that may be dropped: the rules alone are over budget. The author's instructions
    // win, and the interview runs long — a topic the author said to always ask is not the planner's
    // to take away.
    if (index < 0) break;

    const [removed] = planned.splice(index, 1);
    if (!removed) break;
    seen.delete(removed.key);
    dropped.set(removed.key, reason);
  }

  return dropped;
}

/**
 * The conditional topics a planner may choose between: everything not force-excluded by a rule.
 *
 * Force-INCLUDED topics stay in the candidate list on purpose. The planner still needs to know they
 * are part of the interview — a proposal made in ignorance of half the plan would double up on the
 * same ground, and the model's own ordering of the rest is better for knowing what is already there.
 */
export function plannerCandidates(topics: readonly Topic[], rules: RuleOutcome): Topic[] {
  return topics.filter((t) => t.phase === 'conditional' && !rules.exclude.has(t.key));
}

/** The always-run topics, in authored order — what an interview covers regardless of any decision. */
export function alwaysTopics(topics: readonly Topic[]): Topic[] {
  return topics.filter((t) => ALWAYS_PHASES.includes(t.phase));
}

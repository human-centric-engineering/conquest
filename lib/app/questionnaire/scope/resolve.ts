/**
 * Scope resolution (P17) — "which questions and data slots is this interview actually about?"
 *
 * The single function every loader routes through. Pure: no Prisma, no Next, no I/O. Callers hand
 * it the version's topics, the session's plan and the version's settings, and filter their own
 * already-loaded lists against what comes back.
 *
 * ## The inert guarantee
 *
 * Two conditions short-circuit to **full scope** — every question, every data slot, exactly the
 * pre-P17 behaviour:
 *
 *  1. `settings.enabled` is false (the version never opted in), or
 *  2. the version has no topics at all (nothing was ever authored).
 *
 * A third case — `plan` is null on an enabled version — is NOT full scope: it is the pre-planner
 * state, where the always-run phases are in scope and the conditional ones are not yet decided.
 * That is what makes the opening happen before the plan is made rather than alongside it.
 *
 * ## Early seats (F17.36)
 *
 * `earlySeated` is the one thing that puts a conditional topic in scope BEFORE a plan exists. It is
 * unioned with the plan's topics rather than replacing them: an early seat survives sealing, and
 * after sealing the same topic appears in both, which is why the union is by key and the plan's
 * entry wins. The plan is the sealed statement; the early record is how it got there.
 *
 * ## Why unknown keys are silently skipped
 *
 * A topic's `members` are question/data-slot KEYS, and an author can delete a question a topic
 * still names. Every unresolvable key is simply never matched — it cannot appear in an in-scope set
 * because the caller intersects against what it actually loaded. A stale key must never throw: the
 * respondent is mid-interview, and an authoring mistake made last week is not their problem.
 *
 * ## Why a corrupt plan widens rather than narrows
 *
 * `narrowInterviewPlan` returns null for anything it cannot read, and null resolves to the
 * always-phases. Asking someone a question they did not need is a poor experience; silently
 * withholding questions the instrument was meant to ask is a wrong result. When in doubt, ask.
 */

import {
  ALWAYS_PHASES,
  LIGHT_DEPTH_MEMBER_COUNT,
  type ConditionalTopicsSettings,
  type EarlySeating,
  type InterviewPlan,
  type PlannedTopic,
  type Topic,
  type TopicDepth,
} from '@/lib/app/questionnaire/scope/types';

/** What {@link resolveScope} reads. Everything optional beyond the three required inputs. */
export interface ScopeInput {
  /** The version's topics, in authored order. */
  topics: readonly Topic[];
  /** The session's plan, or null before one is made (and forever, on a non-adaptive version). */
  plan: InterviewPlan | null;
  /**
   * Topics seated during the opening, before the plan was sealed (F17.36).
   *
   * Omitted by nearly every caller and null on nearly every session. Present, its `seated` keys are
   * in scope exactly as a planned topic is — which is the whole point: an early seat that did not
   * reach scope would be a decision with no effect.
   */
  earlySeated?: EarlySeating | null;
  /** The version's resolved settings. */
  settings: ConditionalTopicsSettings;
  /**
   * Every question key in the version. Supplied only by callers that need
   * {@link ResolvedScope.notAskedQuestionKeys} — the report and the exports, which must say
   * *not asked* rather than *not answered*.
   */
  allQuestionKeys?: readonly string[];
  /** Every data-slot key in the version. Same purpose as {@link allQuestionKeys}. */
  allDataSlotKeys?: readonly string[];
  /** Per-key weight, for choosing which members a `light` topic contributes. */
  weightByQuestionKey?: ReadonlyMap<string, number>;
  /** Per-key weight, same purpose. */
  weightByDataSlotKey?: ReadonlyMap<string, number>;
}

/** The resolved scope. Sets, so callers filter in O(1) per item. */
export interface ResolvedScope {
  /**
   * False when scope is not filtering anything — the version never opted in, or has no topics.
   * Callers may skip their filter entirely on false; the sets are still correct either way.
   */
  active: boolean;
  /** Topic keys in scope (always-phase topics plus whatever the plan selected). */
  topicKeys: ReadonlySet<string>;
  /** Question keys in scope. */
  questionKeys: ReadonlySet<string>;
  /** Data-slot keys in scope. */
  dataSlotKeys: ReadonlySet<string>;
  /**
   * Question keys that exist in the version but are NOT in scope — the "we did not assess this"
   * set. Empty unless {@link ScopeInput.allQuestionKeys} was supplied.
   */
  notAskedQuestionKeys: ReadonlySet<string>;
  /** Data-slot equivalent of {@link notAskedQuestionKeys}. */
  notAskedDataSlotKeys: ReadonlySet<string>;
  /** question key → the topic key that put it in scope. For grouping a report by topic. */
  topicByQuestionKey: ReadonlyMap<string, string>;
  /** data-slot key → owning topic key. */
  topicByDataSlotKey: ReadonlyMap<string, string>;
  /** Effective depth per in-scope topic — the plan's depth wins over the topic's authored one. */
  depthByTopicKey: ReadonlyMap<string, TopicDepth>;
}

/** Full scope: everything in, nothing recorded as not-asked. The pre-P17 behaviour. */
function fullScope(input: ScopeInput): ResolvedScope {
  const questionKeys = new Set<string>();
  const dataSlotKeys = new Set<string>();
  const topicKeys = new Set<string>();
  const topicByQuestionKey = new Map<string, string>();
  const topicByDataSlotKey = new Map<string, string>();
  const depthByTopicKey = new Map<string, TopicDepth>();

  // Even at full scope the membership maps are populated where topics exist, so a caller that
  // groups output by topic keeps working when an admin turns the feature off again.
  for (const topic of input.topics) {
    topicKeys.add(topic.key);
    depthByTopicKey.set(topic.key, 'full');
    for (const k of topic.members.questionKeys) {
      if (!topicByQuestionKey.has(k)) topicByQuestionKey.set(k, topic.key);
    }
    for (const k of topic.members.dataSlotKeys) {
      if (!topicByDataSlotKey.has(k)) topicByDataSlotKey.set(k, topic.key);
    }
  }
  for (const k of input.allQuestionKeys ?? []) questionKeys.add(k);
  for (const k of input.allDataSlotKeys ?? []) dataSlotKeys.add(k);

  return {
    active: false,
    topicKeys,
    questionKeys,
    dataSlotKeys,
    notAskedQuestionKeys: new Set(),
    notAskedDataSlotKeys: new Set(),
    topicByQuestionKey,
    topicByDataSlotKey,
    depthByTopicKey,
  };
}

/**
 * The members a topic contributes at the given depth.
 *
 * `full` is all of them. `light` takes the {@link LIGHT_DEPTH_MEMBER_COUNT} highest-weight members,
 * falling back to authored order when no weights were supplied — a light topic asked in its
 * authored order is still a valid sample, whereas refusing to resolve without weights would make
 * the blind-spot check depend on the caller remembering to pass a map.
 */
export function membersAtDepth(
  keys: readonly string[],
  depth: TopicDepth,
  weights: ReadonlyMap<string, number> | undefined
): string[] {
  if (depth === 'full' || keys.length <= LIGHT_DEPTH_MEMBER_COUNT) return [...keys];
  if (!weights) return keys.slice(0, LIGHT_DEPTH_MEMBER_COUNT);
  // Stable: equal weights keep authored order, so a light topic asks the same two items every run.
  const indexed = keys.map((key, i) => ({ key, i, w: weights.get(key) ?? 0 }));
  indexed.sort((a, b) => (b.w !== a.w ? b.w - a.w : a.i - b.i));
  return indexed.slice(0, LIGHT_DEPTH_MEMBER_COUNT).map((e) => e.key);
}

/**
 * The members a topic contributes to ONE PLAN: an explicit subset when the plan named one, the
 * depth otherwise (C6, F17.29).
 *
 * The subset is intersected with what the topic actually claims, in AUTHORED order — a plan may
 * narrow a topic, never widen it into questions its author did not put in it, and never reorder
 * the instrument. An intersection that comes out empty falls back to the depth: "in scope and asks
 * nothing" is a topic that reports as covered while contributing no answer, which is worse than
 * asking more than strictly necessary — the same direction every other degradation here takes.
 */
export function plannedMembers(
  authored: readonly string[],
  planned: readonly string[] | undefined,
  depth: TopicDepth,
  weights: ReadonlyMap<string, number> | undefined
): string[] {
  if (planned && planned.length > 0) {
    const wanted = new Set(planned);
    const kept = authored.filter((key) => wanted.has(key));
    if (kept.length > 0) return kept;
  }
  return membersAtDepth(authored, depth, weights);
}

/**
 * Resolve what is in scope for one session.
 *
 * Never throws. Every malformed or missing input degrades toward asking more, not less.
 */
export function resolveScope(input: ScopeInput): ResolvedScope {
  if (!input.settings.enabled || input.topics.length === 0) return fullScope(input);

  const plan = input.plan;
  // Early seats first, then the plan over the top. The plan's entry wins on a key both carry,
  // because sealing is where the depth and any member subset are finally decided — and after
  // sealing every early seat appears in both by construction (`preSeated`).
  const plannedByKey = new Map<string, PlannedTopic>();
  for (const seat of input.earlySeated?.seated ?? []) {
    plannedByKey.set(seat.key, {
      key: seat.key,
      depth: seat.depth,
      source: 'early',
      rationale: seat.rationale,
      ...(seat.respondentReason ? { respondentReason: seat.respondentReason } : {}),
    });
  }
  for (const t of plan?.topics ?? []) plannedByKey.set(t.key, t);

  const topicKeys = new Set<string>();
  const questionKeys = new Set<string>();
  const dataSlotKeys = new Set<string>();
  const topicByQuestionKey = new Map<string, string>();
  const topicByDataSlotKey = new Map<string, string>();
  const depthByTopicKey = new Map<string, TopicDepth>();

  for (const topic of input.topics) {
    const always = ALWAYS_PHASES.includes(topic.phase);
    const planned = plannedByKey.get(topic.key);

    // An always-phase topic is in scope from the first turn; a conditional one only once the plan
    // has named it. Before the plan exists, conditional topics are deliberately absent — that is
    // what makes the opening the thing that decides the rest, rather than running alongside it.
    if (!always && !planned) continue;

    // The plan's depth wins: the check topic is forced `light` at planning time regardless of how
    // its author set it up, because its job in THAT interview is to sample, not to score.
    const depth: TopicDepth = planned?.depth ?? topic.depth;

    topicKeys.add(topic.key);
    depthByTopicKey.set(topic.key, depth);

    for (const key of plannedMembers(
      topic.members.questionKeys,
      planned?.members?.questionKeys,
      depth,
      input.weightByQuestionKey
    )) {
      questionKeys.add(key);
      if (!topicByQuestionKey.has(key)) topicByQuestionKey.set(key, topic.key);
    }
    for (const key of plannedMembers(
      topic.members.dataSlotKeys,
      planned?.members?.dataSlotKeys,
      depth,
      input.weightByDataSlotKey
    )) {
      dataSlotKeys.add(key);
      if (!topicByDataSlotKey.has(key)) topicByDataSlotKey.set(key, topic.key);
    }
  }

  // Membership maps cover EVERY topic, in scope or not, so a report can name the topic a
  // not-asked question belonged to ("we did not assess Talent") rather than listing orphan keys.
  for (const topic of input.topics) {
    for (const k of topic.members.questionKeys) {
      if (!topicByQuestionKey.has(k)) topicByQuestionKey.set(k, topic.key);
    }
    for (const k of topic.members.dataSlotKeys) {
      if (!topicByDataSlotKey.has(k)) topicByDataSlotKey.set(k, topic.key);
    }
  }

  const notAskedQuestionKeys = new Set<string>();
  for (const key of input.allQuestionKeys ?? []) {
    if (!questionKeys.has(key)) notAskedQuestionKeys.add(key);
  }
  const notAskedDataSlotKeys = new Set<string>();
  for (const key of input.allDataSlotKeys ?? []) {
    if (!dataSlotKeys.has(key)) notAskedDataSlotKeys.add(key);
  }

  return {
    active: true,
    topicKeys,
    questionKeys,
    dataSlotKeys,
    notAskedQuestionKeys,
    notAskedDataSlotKeys,
    topicByQuestionKey,
    topicByDataSlotKey,
    depthByTopicKey,
  };
}

/**
 * True when a question key may be asked. Convenience for callers filtering one item at a time.
 *
 * Note the `!active` short-circuit: an inactive scope admits everything, including keys that were
 * never listed in {@link ResolvedScope.questionKeys} because no `allQuestionKeys` was supplied.
 */
export function isQuestionInScope(scope: ResolvedScope, key: string): boolean {
  return !scope.active || scope.questionKeys.has(key);
}

/** True when a data-slot key may be targeted. See {@link isQuestionInScope} on the short-circuit. */
export function isDataSlotInScope(scope: ResolvedScope, key: string): boolean {
  return !scope.active || scope.dataSlotKeys.has(key);
}

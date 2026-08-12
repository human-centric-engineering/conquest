/**
 * Adaptive Scope (P17) — pure domain types.
 *
 * The vocabulary shared by the topic authoring surfaces, the scope resolver, the hard-rule
 * evaluator, the Scope Planner and the Routing Analyst. The `const` tuples below back the
 * TypeScript types, the routes' Zod enums (`z.enum(TOPIC_PHASES)`), the admin UI's selectors, and
 * the `narrowToEnum` reads that guard the plain `String` columns — the house style established by
 * `lib/app/questionnaire/types.ts` and `experiences/types.ts`.
 *
 * ## What this feature is
 *
 * ConQuest already decides **which question next** (selection strategies) and **which questionnaire
 * next** (the Experience switcher). Adaptive Scope fills the gap between them: **which parts of this
 * questionnaire apply to this respondent at all.** Screeners, eligibility, role-specific question
 * sets, compliance sections that must be recorded as not-applicable, and any long instrument that
 * should not ask all of itself to everyone are all the same requirement.
 *
 * ## The one invariant
 *
 * **Off by default, inert by construction.** With `adaptiveScope.enabled` false — or before a
 * session's plan exists — `resolveScope` returns every topic. A version that never opts in behaves
 * exactly as it did before this feature existed, and that equivalence is a tested gate, not a hope.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

import { isRecord } from '@/lib/utils';

/**
 * Local copy of `narrowToEnum` (`lib/app/questionnaire/types.ts`), deliberately.
 *
 * `QuestionnaireConfigShape` carries an {@link AdaptiveScopeSettings} and its default object, so
 * `types.ts` imports THIS module at runtime. Importing back would make the cycle real: whichever
 * module evaluated second would read a not-yet-initialised const and throw at import time. Three
 * lines duplicated is a cheaper price than a load-order-dependent TDZ crash, and keeping this
 * module a leaf is what lets every other layer import it freely.
 */
function narrowToEnum<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * When a topic runs, and whether it is ever a candidate for exclusion.
 *
 * - `opening` — runs first, and is what the planner reads. The signal-gathering part of the
 *   interview: open questions whose answers decide the rest. Never excluded.
 * - `core` — always runs. The spine every respondent gets regardless of what they said.
 * - `conditional` — the only phase the planner ever chooses between. Included when the author's
 *   criteria fit what the respondent conveyed, excluded otherwise.
 * - `closing` — always runs, last. The wrap-up whose answers are worth comparing against the
 *   opening.
 *
 * `core` is the default so an auto-seeded topic is always-asked: seeding a fresh questionnaire must
 * change nothing about how it runs.
 */
export const TOPIC_PHASES = ['opening', 'core', 'conditional', 'closing'] as const;
export type TopicPhase = (typeof TOPIC_PHASES)[number];

/** Human labels for the phase selector. */
export const TOPIC_PHASE_LABELS: Record<TopicPhase, string> = {
  opening: 'Opening — gathers the signal',
  core: 'Always ask',
  conditional: 'Ask when it fits',
  closing: 'Closing — always ask, last',
};

/** One-line descriptions shown beneath each phase in the topic editor. */
export const TOPIC_PHASE_DESCRIPTIONS: Record<TopicPhase, string> = {
  opening:
    'Runs first. Its answers are what the agent reads when deciding which conditional topics apply.',
  core: 'Runs for everyone, whatever they say.',
  conditional: 'Runs only when your criteria fit what the respondent conveyed.',
  closing: 'Runs for everyone, at the end.',
};

/** Phases that always run and are never chosen between. */
export const ALWAYS_PHASES: readonly TopicPhase[] = ['opening', 'core', 'closing'];

/**
 * How much of a topic to include when it is in scope.
 *
 * `full` is everything. `light` includes only the highest-weight members — the "sample one area
 * they did **not** raise" check that stops a diagnostic merely confirming what the respondent
 * already believed. A light topic is a signal, never a score, and every surface that reports it
 * must say so.
 */
export const TOPIC_DEPTHS = ['full', 'light'] as const;
export type TopicDepth = (typeof TOPIC_DEPTHS)[number];

/** Human labels for the depth selector. */
export const TOPIC_DEPTH_LABELS: Record<TopicDepth, string> = {
  full: 'Full — every question in the topic',
  light: 'Light — sample the most important few',
};

/** How many members a `light` topic contributes. Module constant: tuning, not a migration. */
export const LIGHT_DEPTH_MEMBER_COUNT = 2;

/** Where a topic came from. Lets the admin surface mark untouched auto-seeds. */
export const TOPIC_SOURCES = ['seeded', 'manual', 'analyst'] as const;
export type TopicSource = (typeof TOPIC_SOURCES)[number];

/**
 * How a hard rule compares a filled data slot against its operand.
 *
 * Deliberately the same small vocabulary as `ROUTING_RULE_OPERATORS`
 * (`experiences/routing/types.ts`), and for the same reason: rules exist to hard-pin the handful of
 * cases an author is certain about, and a flat list is legible at a glance in a way a boolean tree
 * is not. Anything richer is what the planner's plain-English criteria are for.
 */
export const SCOPE_RULE_OPERATORS = ['equals', 'contains', 'gt', 'lt', 'exists'] as const;
export type ScopeRuleOperator = (typeof SCOPE_RULE_OPERATORS)[number];

/** Human labels for the operator select. */
export const SCOPE_RULE_OPERATOR_LABELS: Record<ScopeRuleOperator, string> = {
  equals: 'is exactly',
  contains: 'mentions',
  gt: 'is greater than',
  lt: 'is less than',
  exists: 'has any answer',
};

/** Operators that ignore `value` — the admin form hides the operand field for these. */
export const VALUELESS_SCOPE_OPERATORS: readonly ScopeRuleOperator[] = ['exists'];

/**
 * What a matching rule does. `include` forces a conditional topic in; `exclude` forces it out.
 *
 * Exclude exists because the most valuable hard rules are usually negative — "never score them
 * against AI readiness when they never named an outcome they want it to move" — and expressing that
 * as an include on every other topic is both fragile and unreadable.
 */
export const SCOPE_RULE_ACTIONS = ['include', 'exclude'] as const;
export type ScopeRuleAction = (typeof SCOPE_RULE_ACTIONS)[number];

/** Human labels for the action selector. */
export const SCOPE_RULE_ACTION_LABELS: Record<ScopeRuleAction, string> = {
  include: 'always include',
  exclude: 'never include',
};

/**
 * Why a topic ended up in (or out of) a plan. Recorded per topic so an admin can tell an AI
 * judgement from a hard rule from a safety net from the respondent's own request — the same
 * distinction `RoutingDecision.source` draws for the Experience switcher.
 */
export const SCOPE_DECISION_SOURCES = [
  'phase',
  'rule',
  'llm',
  'fallback',
  'check',
  'respondent',
] as const;
export type ScopeDecisionSource = (typeof SCOPE_DECISION_SOURCES)[number];

/** Human labels for the decision-source badge on admin surfaces. */
export const SCOPE_DECISION_SOURCE_LABELS: Record<ScopeDecisionSource, string> = {
  phase: 'Always asked',
  rule: 'Matched a rule you set',
  llm: 'Chosen by the agent',
  fallback: 'Safe default',
  check: 'Blind-spot check',
  respondent: 'Respondent asked for it',
};

/* -------------------------------------------------------------------------- */
/* Field bounds                                                               */
/* -------------------------------------------------------------------------- */

export const TOPIC_KEY_MAX_LENGTH = 64;
export const TOPIC_LABEL_MAX_LENGTH = 200;
export const TOPIC_DESCRIPTION_MAX_LENGTH = 1_000;
export const TOPIC_CRITERIA_MAX_LENGTH = 2_000;
export const SCOPE_RULE_VALUE_MAX_LENGTH = 500;
export const PLANNER_INSTRUCTIONS_MAX_LENGTH = 4_000;
export const RESPONDENT_MESSAGE_MAX_LENGTH = 1_000;
export const SCOPE_RATIONALE_MAX_LENGTH = 1_000;

/** Bounds on how many conditional topics one interview may cover. */
export const MIN_CONDITIONAL_TOPICS = 1;
export const MAX_CONDITIONAL_TOPICS_CEILING = 20;

/** Bounds on the planner confidence threshold. 0 accepts any answer; 1 accepts only certainty. */
export const MIN_SCOPE_CONFIDENCE_FLOOR = 0;
export const MIN_SCOPE_CONFIDENCE_CEILING = 1;

/* -------------------------------------------------------------------------- */
/* Topics                                                                     */
/* -------------------------------------------------------------------------- */

/** A topic's membership — KEYS, never row ids, so it survives a version fork. */
export interface TopicMembers {
  dataSlotKeys: string[];
  questionKeys: string[];
}

/** The empty membership. A topic with no members is inert and the launch check flags it. */
export const EMPTY_TOPIC_MEMBERS: TopicMembers = { dataSlotKeys: [], questionKeys: [] };

/** One topic, as every pure consumer sees it (`AppQuestionnaireTopic` projected). */
export interface Topic {
  id: string;
  key: string;
  label: string;
  description: string | null;
  phase: TopicPhase;
  criteria: string | null;
  depth: TopicDepth;
  members: TopicMembers;
  ordinal: number;
  source: TopicSource;
}

/* -------------------------------------------------------------------------- */
/* Hard rules                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One hard rule. Evaluated before the planner; every match applies (unlike the Experience router's
 * first-match-wins), because include and exclude are independent assertions about different topics
 * and "the first one wins" would silently drop the rest.
 *
 * `exclude` beats `include` on the same topic: a rule saying "never" is an author drawing a line,
 * and a line drawn should not be crossed by a second rule they forgot about.
 */
export interface ScopeRule {
  id: string;
  /** The data-slot key this rule tests against the session's fills. */
  dataSlotKey: string;
  operator: ScopeRuleOperator;
  /** Comparison operand. Null for `exists`, which tests only for a filled slot. */
  value: string | null;
  action: ScopeRuleAction;
  /** The `key` of the topic this rule acts on. An unresolvable key is skipped and logged. */
  topicKey: string;
  ordinal: number;
}

/* -------------------------------------------------------------------------- */
/* Version settings                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The lazily-defaulted `adaptiveScope` Json on `AppQuestionnaireConfig`.
 *
 * A blob rather than columns because this is one coherent feature with a dozen knobs and a rule
 * list — the same judgement `respondentReport` / `cohortReport` / `intro` already make. Read through
 * {@link narrowAdaptiveScopeSettings}, never destructured raw.
 */
export interface AdaptiveScopeSettings {
  /**
   * The master switch. **False by default.** While false, `resolveScope` returns every topic and
   * the planner never runs, so the version behaves exactly as it did pre-P17.
   */
  enabled: boolean;

  /**
   * How many `conditional` topics one interview may cover. The planner proposes; this caps.
   *
   * This is the honest replacement for a client's "no more than three sections, because three
   * sections is 334 seconds" arithmetic: the intent is breadth control, and breadth is what this
   * counts. Depth and length are already governed by `maxQuestionsPerSession` and `costBudgetUsd`.
   */
  maxConditionalTopics: number;

  /**
   * Include one topic the planner did **not** choose, at `light` depth.
   *
   * Deliberately on by default. A diagnostic that only asks about the problem the respondent
   * already named can only confirm what they already believed; sampling one area they did not raise
   * is what makes the result capable of surprising them.
   */
  includeCheckTopic: boolean;

  /**
   * Preferred topic keys for the check topic, best first. Empty means "the highest-weight topic
   * that missed the cut", which is the more informative default; naming keys makes it predictable.
   */
  checkTopicPreference: string[];

  /** Below this confidence the planner's answer is discarded and the fallback set applies. */
  minConfidence: number;

  /**
   * The topics used when the planner cannot decide — it errored, returned nothing usable, or came
   * in under `minConfidence`. Empty means "conclude with the always-topics only", which is always
   * coherent, if thin.
   */
  fallbackTopicKeys: string[];

  /**
   * Tell the respondent which topics were chosen, before running them.
   *
   * On by default, and it is not merely courtesy: naming the selection back proves the interview
   * listened, justifies the time it is about to ask for, and gives the respondent the one chance
   * they will get to object before it is spent.
   */
  announce: boolean;

  /**
   * Honour a respondent who asks for a topic that was not selected ("actually, ask me about
   * talent"). Recorded on the plan as an amendment and excluded from routing-quality analytics —
   * their correction is signal about the planner, not an example of it working.
   */
  allowRespondentAmendment: boolean;

  /** Admin-authored guidance appended to the planner prompt. */
  plannerInstructions: string;

  /** The hard rules, evaluated before the planner. */
  rules: ScopeRule[];
}

/** The lazy default — what `{}` resolves to, and what a fresh version runs with. */
export const DEFAULT_ADAPTIVE_SCOPE_SETTINGS: AdaptiveScopeSettings = {
  enabled: false,
  maxConditionalTopics: 3,
  includeCheckTopic: true,
  checkTopicPreference: [],
  minConfidence: 0.6,
  fallbackTopicKeys: [],
  announce: true,
  allowRespondentAmendment: true,
  plannerInstructions: '',
  rules: [],
};

/* -------------------------------------------------------------------------- */
/* The interview plan                                                         */
/* -------------------------------------------------------------------------- */

/** One topic's place in a plan, with the reason it is there. */
export interface PlannedTopic {
  key: string;
  depth: TopicDepth;
  source: ScopeDecisionSource;
  /** Why, in a sentence — for the admin surface, never shown to the respondent. */
  rationale: string;
}

/** One topic the planner considered and left out, with the reason. */
export interface ExcludedTopic {
  key: string;
  source: ScopeDecisionSource;
  rationale: string;
}

/**
 * The per-session artifact, stored on `AppQuestionnaireSession.interviewPlan`.
 *
 * Written ONCE when the opening topics are covered, then frozen apart from respondent amendments —
 * the same "decide at the handoff and never recompute" discipline as `AppExperienceRun.carryOver`.
 * A finished report must not shift underneath itself because a later answer would have routed
 * differently.
 *
 * `null` on the column means "no plan yet", which is both the pre-planner state of an adaptive
 * session and the permanent state of every ordinary one. Both resolve to full scope.
 */
export interface InterviewPlan {
  /** Schema version of this blob, so a later shape change can migrate on read. */
  v: 1;
  /** Conditional topics in scope. Always-phase topics are NOT listed — they need no decision. */
  topics: PlannedTopic[];
  /** Conditional topics considered and left out. */
  excluded: ExcludedTopic[];
  /** The `light`-depth check topic, when one was added. */
  checkTopicKey: string | null;
  /** The planner's own clamped confidence, 0–1. */
  confidence: number;
  /** What produced the plan overall. */
  source: ScopeDecisionSource;
  /** The line spoken to the respondent at the handover. Empty when `announce` is off. */
  respondentMessage: string;
  /** Turn ordinal the plan was decided at — lets the transcript show where the interview turned. */
  decidedAtTurn: number;
  /** ISO timestamp. */
  decidedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Narrowers                                                                  */
/* -------------------------------------------------------------------------- */

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asText(value: unknown, max: number, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function asNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Trimmed, de-duplicated, bounded string list. Drops blanks — an empty key is never a key. */
function asKeyList(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().slice(0, TOPIC_KEY_MAX_LENGTH);
    if (key.length === 0 || out.includes(key)) continue;
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/** Project a stored `members` Json onto a complete {@link TopicMembers}. */
export function narrowTopicMembers(value: unknown): TopicMembers {
  const obj = isRecord(value) ? value : {};
  return {
    dataSlotKeys: asKeyList(obj.dataSlotKeys, 500),
    questionKeys: asKeyList(obj.questionKeys, 500),
  };
}

/** Project one stored rule. Returns null when it could never match anything useful. */
function narrowScopeRule(value: unknown, index: number): ScopeRule | null {
  if (!isRecord(value)) return null;
  const dataSlotKey = asText(value.dataSlotKey, TOPIC_KEY_MAX_LENGTH, '');
  const topicKey = asText(value.topicKey, TOPIC_KEY_MAX_LENGTH, '');
  // A rule naming no slot or no topic is unresolvable by construction — drop it rather than keep a
  // row that can only ever no-op, which would read to an admin as a rule that is quietly failing.
  if (dataSlotKey.length === 0 || topicKey.length === 0) return null;
  const operator = narrowToEnum(
    typeof value.operator === 'string' ? value.operator : '',
    SCOPE_RULE_OPERATORS,
    'exists'
  );
  const rawValue = typeof value.value === 'string' ? value.value.trim() : '';
  return {
    id: asText(value.id, 64, '') || `rule-${index}`,
    dataSlotKey,
    operator,
    value: rawValue.length > 0 ? rawValue.slice(0, SCOPE_RULE_VALUE_MAX_LENGTH) : null,
    action: narrowToEnum(
      typeof value.action === 'string' ? value.action : '',
      SCOPE_RULE_ACTIONS,
      'include'
    ),
    topicKey,
    ordinal: asNumber(value.ordinal, 0, 10_000, index),
  };
}

/**
 * Project the stored `adaptiveScope` Json onto a complete {@link AdaptiveScopeSettings}.
 *
 * Missing keys fall back to {@link DEFAULT_ADAPTIVE_SCOPE_SETTINGS}; unknown keys are dropped;
 * numbers are clamped rather than rejected. A malformed blob therefore degrades to "feature off",
 * which is the only safe direction for a setting that decides what a respondent is asked.
 */
export function narrowAdaptiveScopeSettings(value: unknown): AdaptiveScopeSettings {
  const obj = isRecord(value) ? value : {};
  const d = DEFAULT_ADAPTIVE_SCOPE_SETTINGS;
  const rules: ScopeRule[] = Array.isArray(obj.rules)
    ? obj.rules
        .map((r, i) => narrowScopeRule(r, i))
        .filter((r): r is ScopeRule => r !== null)
        .sort((a, b) => a.ordinal - b.ordinal)
    : d.rules;

  return {
    enabled: asBool(obj.enabled, d.enabled),
    maxConditionalTopics: Math.round(
      asNumber(
        obj.maxConditionalTopics,
        MIN_CONDITIONAL_TOPICS,
        MAX_CONDITIONAL_TOPICS_CEILING,
        d.maxConditionalTopics
      )
    ),
    includeCheckTopic: asBool(obj.includeCheckTopic, d.includeCheckTopic),
    checkTopicPreference: asKeyList(obj.checkTopicPreference),
    minConfidence: asNumber(
      obj.minConfidence,
      MIN_SCOPE_CONFIDENCE_FLOOR,
      MIN_SCOPE_CONFIDENCE_CEILING,
      d.minConfidence
    ),
    fallbackTopicKeys: asKeyList(obj.fallbackTopicKeys),
    announce: asBool(obj.announce, d.announce),
    allowRespondentAmendment: asBool(obj.allowRespondentAmendment, d.allowRespondentAmendment),
    plannerInstructions: asText(
      obj.plannerInstructions,
      PLANNER_INSTRUCTIONS_MAX_LENGTH,
      d.plannerInstructions
    ),
    rules,
  };
}

/**
 * Project a stored `interviewPlan` Json onto an {@link InterviewPlan}, or null.
 *
 * Null on absent, malformed, or unknown-version input — and null means "full scope", so a corrupt
 * plan widens the interview rather than narrowing it. That direction is deliberate: asking a
 * respondent something they did not need is a poor experience, whereas silently withholding
 * questions an instrument was meant to ask is a wrong result.
 */
export function narrowInterviewPlan(value: unknown): InterviewPlan | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;

  const topics: PlannedTopic[] = Array.isArray(value.topics)
    ? value.topics.flatMap((t): PlannedTopic[] => {
        if (!isRecord(t)) return [];
        const key = asText(t.key, TOPIC_KEY_MAX_LENGTH, '');
        if (key.length === 0) return [];
        return [
          {
            key,
            depth: narrowToEnum(typeof t.depth === 'string' ? t.depth : '', TOPIC_DEPTHS, 'full'),
            source: narrowToEnum(
              typeof t.source === 'string' ? t.source : '',
              SCOPE_DECISION_SOURCES,
              'llm'
            ),
            rationale: asText(t.rationale, SCOPE_RATIONALE_MAX_LENGTH, ''),
          },
        ];
      })
    : [];

  const excluded: ExcludedTopic[] = Array.isArray(value.excluded)
    ? value.excluded.flatMap((t): ExcludedTopic[] => {
        if (!isRecord(t)) return [];
        const key = asText(t.key, TOPIC_KEY_MAX_LENGTH, '');
        if (key.length === 0) return [];
        return [
          {
            key,
            source: narrowToEnum(
              typeof t.source === 'string' ? t.source : '',
              SCOPE_DECISION_SOURCES,
              'llm'
            ),
            rationale: asText(t.rationale, SCOPE_RATIONALE_MAX_LENGTH, ''),
          },
        ];
      })
    : [];

  const checkTopicKey = asText(value.checkTopicKey, TOPIC_KEY_MAX_LENGTH, '');

  return {
    v: 1,
    topics,
    excluded,
    checkTopicKey: checkTopicKey.length > 0 ? checkTopicKey : null,
    confidence: asNumber(value.confidence, 0, 1, 0),
    source: narrowToEnum(
      typeof value.source === 'string' ? value.source : '',
      SCOPE_DECISION_SOURCES,
      'llm'
    ),
    respondentMessage: asText(value.respondentMessage, RESPONDENT_MESSAGE_MAX_LENGTH, ''),
    decidedAtTurn: Math.round(asNumber(value.decidedAtTurn, 0, 100_000, 0)),
    decidedAt: asText(value.decidedAt, 40, ''),
  };
}

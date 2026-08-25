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
  conditional: 'Conditional — ask when it fits',
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
export const SCOPE_RULE_OPERATORS = [
  'equals',
  'contains',
  'gt',
  'lt',
  'exists',
  'not_exists',
] as const;
export type ScopeRuleOperator = (typeof SCOPE_RULE_OPERATORS)[number];

/** Human labels for the operator select. */
export const SCOPE_RULE_OPERATOR_LABELS: Record<ScopeRuleOperator, string> = {
  equals: 'is exactly',
  contains: 'mentions',
  gt: 'is greater than',
  lt: 'is less than',
  exists: 'has any answer',
  not_exists: 'was never answered',
};

/** Operators that ignore `value` — the admin form hides the operand field for these. */
export const VALUELESS_SCOPE_OPERATORS: readonly ScopeRuleOperator[] = ['exists', 'not_exists'];

/**
 * The one operator that matches on ABSENCE, and therefore the one exception to "an unfilled slot
 * never matches".
 *
 * It exists because the most valuable hard rules are vetoes — "never score them on AI readiness
 * when they never named an outcome they want it to move" — and a veto is a statement about
 * something the respondent did NOT say. Without it, that rule can only be written as prose criteria
 * for the planner to weigh, which is precisely the failure mode hard rules exist to avoid: a
 * constraint obeyed most of the time.
 *
 * Named as a constant rather than inlined because two places have to agree about it — the evaluator
 * (which must let it past the unfilled-slot guard) and the admin form (which must not ask for an
 * operand).
 */
export const NEGATIVE_SCOPE_OPERATOR: ScopeRuleOperator = 'not_exists';

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
  'budget',
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
  // Only ever appears on an EXCLUDED topic. The agent chose this one and the time budget took it
  // back, which is a different answer to "why was I not asked about that" than "it was not chosen".
  budget: 'Dropped — over the time budget',
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

/**
 * Most keys the Routing Analyst may propose for `fallbackTopicKeys` / `checkTopicPreference`.
 *
 * Lives here rather than beside the analyst's other output caps because BOTH sides need it — the
 * analyst's contract and `narrowProposedTopicSet`'s read — and `types.ts` is the leaf module, so
 * this is the only direction the import can go without a cycle. A literal in the narrow was the
 * alternative and it silently truncated whenever this number moved.
 *
 * A hint, not a second topic list: the settings themselves accept up to 20 through the PATCH.
 */
export const MAX_PROPOSED_SETTING_KEYS = 5;

/**
 * Bounds on a session's time budget, in seconds. `0` means "no budget" and is the default, so
 * nothing changes for a version that never sets one.
 *
 * The ceiling is four hours — absurd for a conversational questionnaire, which is the point: it
 * exists to stop a stored blob carrying nonsense, not to express a view about how long an interview
 * should be. The floor of 30s is one free-text answer.
 */
export const MIN_SESSION_BUDGET_SECONDS = 30;
export const MAX_SESSION_BUDGET_SECONDS = 14_400;

/**
 * Bounds on the opening's shared follow-up allowance (G03).
 *
 * `0` is legal and means "never probe in the opening" — an instrument whose opening questions are
 * concrete enough that a follow-up is always waste. The ceiling is deliberately small: the whole
 * point of the allowance is that a probe is expensive, and an author who wants six of them does not
 * want an allowance, they want the per-slot cap they already have.
 */
export const MIN_OPENING_PROBES = 0;
export const MAX_OPENING_PROBES_CEILING = 5;

/** Bounds on a per-question-type time estimate, in seconds. */
export const MIN_SECONDS_PER_ITEM = 1;
export const MAX_SECONDS_PER_ITEM = 600;

/**
 * Seconds one data slot costs a respondent, by default.
 *
 * Priced as an open question rather than by type, because a data slot is filled from conversation:
 * the respondent talks, and the extractor listens. 40s is the pilot client workbook's own estimate for
 * an opening question, which is exactly the shape of thing data slots capture.
 */
export const DEFAULT_SECONDS_PER_DATA_SLOT = 40;

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
/* The Routing Analyst's proposal                                             */
/* -------------------------------------------------------------------------- */

/**
 * One topic as the Routing Analyst proposes it — a {@link Topic} with the two things a REVIEWER
 * needs and a live topic does not.
 *
 * `rationale` is the analyst's account of why; `sourceQuote` is the span of the uploaded document
 * that says so. Both exist because the admin's job here is adjudication, not authorship: a proposal
 * they cannot trace back to the instrument's own words is one they must re-derive from scratch,
 * which is more work than writing the topic themselves.
 */
export interface ProposedTopic {
  key: string;
  label: string;
  phase: TopicPhase;
  criteria: string | null;
  depth: TopicDepth;
  members: TopicMembers;
  /** Why the analyst judged this a topic, and this phase. Never shown to a respondent. */
  rationale: string;
  /** The span of the source document this was drawn from, when the document actually says it. */
  sourceQuote?: string;
  /** True when a live topic already carries this key — the review surface shows it as a change. */
  replacesExisting?: boolean;
}

/** One hard rule as the analyst proposes it. Same shape as {@link ScopeRule}, plus the provenance. */
export interface ProposedScopeRule {
  dataSlotKey: string;
  operator: ScopeRuleOperator;
  value: string | null;
  action: ScopeRuleAction;
  topicKey: string;
  rationale: string;
  sourceQuote?: string;
}

/**
 * Routing language the analyst recognized but could not formalize into a topic or a hard rule
 * (Phase 2, F17.19) — a vague eligibility clause, a rule that would need a data slot the instrument
 * never produced, an instruction that contradicts another one. Unlike a topic or rule, `sourceQuote`
 * is never optional: a gap exists to admit what the document said that the proposal above does not
 * cover, so it must always be traceable to the document's own words.
 */
export interface ProposedGap {
  sourceQuote: string;
  explanation: string;
}

/**
 * The reviewable proposal stored on `AppQuestionnaireTopicDraft.topics`.
 *
 * Topics and rules travel together on purpose: the analyst reads a document's routing instructions
 * as one piece of prose ("ask about pricing only for companies over 50 staff — and never score
 * enterprise accounts on self-serve onboarding"), and splitting that across two review surfaces
 * would make each half un-reviewable on its own.
 */
export interface ProposedTopicSet {
  v: 1;
  topics: ProposedTopic[];
  rules: ProposedScopeRule[];
  /** Routing language recognized but not formalized into a topic or rule (Phase 2, F17.19). */
  gaps: ProposedGap[];
  /**
   * The topic limit the document itself implies, when it states one ("no more than three areas per
   * session"). Absent when the document says nothing about breadth — proposing a default here
   * would put the analyst's guess where the author's silence was.
   */
  maxConditionalTopics?: number;
  /**
   * Topics to ask when the planner produced nothing at all — the document's own safe default, when
   * it names one. Absent when it says nothing, same discipline as {@link maxConditionalTopics}.
   */
  fallbackTopicKeys?: string[];
  /**
   * Preferred topics for the blind-spot check, best first. Absent when the document says nothing.
   *
   * Before F17.23 the analyst had no field for this, so a document that named a blind-spot area
   * ("carry two items from a section they did not pick") came back as an unformalizable `gap` — a
   * proposal admitting defeat about a setting the platform has implemented all along.
   */
  checkTopicPreference?: string[];
  /**
   * Topics whose `light` depth was corrected to `full` on the way in, because they run for
   * everyone. Empty on a well-formed proposal.
   *
   * The correction is silent to the runtime but must NOT be silent to the reviewer: the analyst
   * asked for something that would have dropped questions, and an admin who is never told cannot
   * learn that their document's wording invited it. See {@link narrowProposedTopicSet}.
   */
  depthCorrectedKeys?: string[];
  /** What the analyst found, in a sentence or two. The first thing the reviewer reads. */
  summary: string;
  /**
   * Whether the source document actually contained routing instructions.
   *
   * False means the analyst inferred everything from the questionnaire's own structure, which is a
   * materially weaker proposal and must be labelled as one. "I read your routing rules" and "I
   * guessed from your section headings" are different claims.
   */
  fromDocument: boolean;
  /** ISO timestamp of the run. */
  generatedAt: string;
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

  /**
   * How long one interview may take, in seconds. **`0` means no budget**, which is the default.
   *
   * The honest form of what {@link maxConditionalTopics} approximates. A count cannot see that one
   * topic is ten likerts and another is three, so "at most three topics" is not a length — it is a
   * proxy that happens to be right for the instrument it was derived from and wrong for the next
   * one. Set this and an author can say "make it ten minutes" and have the arithmetic done for
   * them.
   *
   * Both constraints apply: the count remains a hard ceiling on breadth, and this bounds duration.
   * They answer different questions and neither implies the other.
   */
  sessionBudgetSeconds: number;

  /**
   * Seconds one item of each question type costs a respondent, keyed by `QuestionType`, overriding
   * `DEFAULT_SECONDS_PER_TYPE` (in `scope/budget.ts`) per version.
   *
   * Per version because instruments differ more than types do: a likert battery in a familiar
   * domain moves faster than one asking respondents to rate things they have never considered.
   * Partial — an absent type falls back to the default rather than to zero, because a type costed
   * at nothing would quietly make a topic free.
   *
   * Typed `Record<string, number>` rather than `Partial<Record<QuestionType, number>>` on purpose:
   * this module is a pure leaf that `lib/app/questionnaire/types.ts` imports FROM, so importing
   * `QuestionType` back would be a value-level cycle. `scope/budget.ts` sits above both and does the
   * type-aware lookup; an unrecognised key here is simply never asked for.
   */
  secondsPerQuestionType: Record<string, number>;

  /**
   * Seconds one data slot costs. Data slots are filled from conversation rather than asked as a
   * form field, so they are priced as an open question rather than by type.
   */
  secondsPerDataSlot: number;

  /**
   * Ration follow-up questions across the opening (G03). **False by default**, and while false the
   * opening probes exactly as it always has — the per-slot `maxDataSlotAttempts` cap alone.
   *
   * A pair rather than a single number because `0` is a meaningful setting here ("never probe"),
   * so it cannot double as the off switch the way `sessionBudgetSeconds: 0` does.
   */
  limitOpeningProbes: boolean;

  /**
   * How many follow-ups the **whole opening** gets, when {@link limitOpeningProbes} is on.
   *
   * The unit is the interview, not the question. A per-slot cap cannot express "one probe for the
   * whole opening", because it has no idea a probe was already spent three questions ago — and
   * every probe costs a routed section of the session budget, which is what makes the allowance
   * shared rather than per item.
   */
  maxOpeningProbes: number;

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
  // 0 = no budget. Every version that predates this behaves exactly as it did.
  sessionBudgetSeconds: 0,
  secondsPerQuestionType: {},
  secondsPerDataSlot: DEFAULT_SECONDS_PER_DATA_SLOT,
  // Off. The allowance below is what an author gets when they turn it on, not what they run today.
  limitOpeningProbes: false,
  maxOpeningProbes: 1,
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

/**
 * A topic the RESPONDENT asked for after the plan was made — Adaptive Scope (P17.6).
 *
 * Recorded alongside the topic's entry in {@link InterviewPlan.topics} (which carries
 * `source: 'respondent'`) rather than instead of it, because the two answer different questions:
 * the topic entry says what the interview covered, this says when and why it changed.
 *
 * `atTurn` exists so the acknowledgement gets exactly one outing, the same mechanism
 * `decidedAtTurn` gives the original announcement. Without it the interviewer would re-acknowledge
 * the request every turn for the rest of the interview.
 */
export interface PlanAmendment {
  /** The topic key that was added. */
  key: string;
  /** The topic's label at the time, so the record reads even after a rename. */
  label: string;
  /** The respondent's own words, trimmed — what they actually asked for. */
  request: string;
  /** Turn ordinal the amendment was made at. */
  atTurn: number;
  /** ISO timestamp. */
  at: string;
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
  /**
   * What this interview was estimated to cost the respondent, in seconds — the always-run topics
   * plus everything the plan seated, priced by `scope/budget.ts` at the moment of the decision.
   *
   * Absent when the version has no session budget, which is the default and therefore most plans.
   * Recorded rather than recomputed on read because the instrument can be edited afterwards: a
   * figure derived from today's questions would answer "what would this interview cost now",
   * which is not the question an admin holding a challenged report is asking.
   */
  estimatedSeconds?: number;
  /** The budget the estimate was fitted to, in seconds. Absent alongside {@link estimatedSeconds}. */
  budgetSeconds?: number;
  /**
   * Topics the respondent asked for after the fact (P17.6). Absent on a plan nobody amended, which
   * is nearly all of them — and on every plan written before amendments shipped.
   *
   * These are deliberately visible to routing-quality analytics as a SEPARATE signal: a respondent
   * correcting the plan is evidence *about* the planner, not an example of it working, and counting
   * an amended topic as a successful selection would make the planner look better the worse it got.
   */
  amendments?: PlanAmendment[];
}

/**
 * One topic an interview did not fully cover, as the report and exports consume it.
 *
 * `partial: true` means the topic WAS in scope but contributed only some of its members — a
 * `light`-depth sample. The distinction is load-bearing: "we looked lightly" and "we did not look"
 * are different claims about a respondent, and a report that blurs them overstates its own coverage.
 */
export interface NotAssessedTopic {
  key: string;
  label: string;
  /** How many of the topic's questions were not asked. */
  questionCount: number;
  partial: boolean;
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

/**
 * Narrow a session budget: `0` (or anything unusable) means no budget; otherwise clamp to the
 * legal range. Deliberately NOT a plain clamp — see the call site.
 */
function asBudgetSeconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  return Math.min(MAX_SESSION_BUDGET_SECONDS, Math.max(MIN_SESSION_BUDGET_SECONDS, rounded));
}

/**
 * Narrow a per-type seconds override. Unusable entries are DROPPED rather than defaulted to zero:
 * a type costed at nothing makes every topic using it look free, which is the one failure a time
 * budget cannot afford.
 */
function asSecondsMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    out[key] = Math.min(MAX_SECONDS_PER_ITEM, Math.max(MIN_SECONDS_PER_ITEM, Math.round(raw)));
  }
  return out;
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
    // 0 is the only value below the floor that survives, and it means "no budget". Clamping a
    // fat-fingered 5 up to 30 would silently create a budget nobody asked for, so anything that is
    // not a usable duration reads as off.
    sessionBudgetSeconds: asBudgetSeconds(obj.sessionBudgetSeconds, d.sessionBudgetSeconds),
    secondsPerQuestionType: asSecondsMap(obj.secondsPerQuestionType),
    secondsPerDataSlot: Math.round(
      asNumber(
        obj.secondsPerDataSlot,
        MIN_SECONDS_PER_ITEM,
        MAX_SECONDS_PER_ITEM,
        d.secondsPerDataSlot
      )
    ),
    limitOpeningProbes: asBool(obj.limitOpeningProbes, d.limitOpeningProbes),
    maxOpeningProbes: Math.round(
      asNumber(
        obj.maxOpeningProbes,
        MIN_OPENING_PROBES,
        MAX_OPENING_PROBES_CEILING,
        d.maxOpeningProbes
      )
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

  // The two budget figures travel together or not at all — an estimate with no budget beside it
  // cannot be read (is 400s tight or generous?), and a budget with no estimate says nothing about
  // what happened. Bounded generously: these are estimates in seconds, not durations to enforce.
  const budgetSeconds = Math.round(asNumber(value.budgetSeconds, 0, 100_000, 0));
  const estimatedSeconds = Math.round(asNumber(value.estimatedSeconds, 0, 100_000, 0));

  const amendments: PlanAmendment[] = Array.isArray(value.amendments)
    ? value.amendments.flatMap((a): PlanAmendment[] => {
        if (!isRecord(a)) return [];
        const key = asText(a.key, TOPIC_KEY_MAX_LENGTH, '');
        if (key.length === 0) return [];
        return [
          {
            key,
            label: asText(a.label, TOPIC_LABEL_MAX_LENGTH, key),
            request: asText(a.request, RESPONDENT_MESSAGE_MAX_LENGTH, ''),
            atTurn: Math.round(asNumber(a.atTurn, 0, 100_000, 0)),
            at: asText(a.at, 40, ''),
          },
        ];
      })
    : [];

  return {
    v: 1,
    topics,
    excluded,
    // Omitted entirely when empty rather than stored as `[]`, so "nobody amended this plan" and
    // "this plan predates amendments" stay indistinguishable — as they should be, since neither
    // says anything about the planner.
    ...(amendments.length > 0 ? { amendments } : {}),
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
    // Omitted when absent, exactly like `amendments`: a plan made without a budget and a plan made
    // before budgets existed are the same plan, and inventing a `0` here would read on the admin
    // surface as "fitted to a budget of nothing".
    ...(budgetSeconds > 0 ? { budgetSeconds, estimatedSeconds } : {}),
  };
}

/**
 * Project a stored `AppQuestionnaireTopicDraft.topics` Json onto a {@link ProposedTopicSet}, or null.
 *
 * Null on absent, malformed, or unknown-version input — and null means "no pending proposal", which
 * is the right direction for a draft: an unreadable proposal must read as *nothing to review*, never
 * as a half-parsed set an admin might accept without noticing what fell out of it.
 */
export function narrowProposedTopicSet(value: unknown): ProposedTopicSet | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;

  // Topic keys whose `light` depth was corrected on the way in — collected here rather than
  // returned per-topic because the reviewer needs the list, not a flag on each row.
  const depthCorrectedKeys: string[] = [];

  const topics: ProposedTopic[] = Array.isArray(value.topics)
    ? value.topics.flatMap((t): ProposedTopic[] => {
        if (!isRecord(t)) return [];
        const key = asText(t.key, TOPIC_KEY_MAX_LENGTH, '');
        const label = asText(t.label, TOPIC_LABEL_MAX_LENGTH, '');
        if (key.length === 0 || label.length === 0) return [];
        const criteria = asText(t.criteria, TOPIC_CRITERIA_MAX_LENGTH, '');
        const sourceQuote = asText(t.sourceQuote, TOPIC_CRITERIA_MAX_LENGTH, '');
        const phase = narrowToEnum(
          typeof t.phase === 'string' ? t.phase : '',
          TOPIC_PHASES,
          'core'
        );
        const askedDepth = narrowToEnum(
          typeof t.depth === 'string' ? t.depth : '',
          TOPIC_DEPTHS,
          'full'
        );
        // `light` on a phase everyone gets does not sample, it deletes — `membersAtDepth` applies
        // depth to every phase, so the members it trims from an always-run topic are asked of
        // nobody. Corrected here rather than refused at the schema on purpose: a hard rejection
        // would throw away an otherwise-good fifteen-topic proposal (and pay for a second model
        // call) over one field, and the analyst has produced exactly this mistake on real
        // instruments. Corrected AND reported — `depthCorrectedKeys` is what stops it being silent.
        const corrected = ALWAYS_PHASES.includes(phase) && askedDepth === 'light';
        if (corrected) depthCorrectedKeys.push(key);
        return [
          {
            key,
            label,
            phase,
            criteria: criteria.length > 0 ? criteria : null,
            depth: corrected ? 'full' : askedDepth,
            members: narrowTopicMembers(t.members),
            rationale: asText(t.rationale, SCOPE_RATIONALE_MAX_LENGTH, ''),
            ...(sourceQuote.length > 0 ? { sourceQuote } : {}),
            ...(t.replacesExisting === true ? { replacesExisting: true } : {}),
          },
        ];
      })
    : [];

  const rules: ProposedScopeRule[] = Array.isArray(value.rules)
    ? value.rules.flatMap((r): ProposedScopeRule[] => {
        if (!isRecord(r)) return [];
        const dataSlotKey = asText(r.dataSlotKey, TOPIC_KEY_MAX_LENGTH, '');
        const topicKey = asText(r.topicKey, TOPIC_KEY_MAX_LENGTH, '');
        if (dataSlotKey.length === 0 || topicKey.length === 0) return [];
        const rawValue = asText(r.value, SCOPE_RULE_VALUE_MAX_LENGTH, '');
        const sourceQuote = asText(r.sourceQuote, TOPIC_CRITERIA_MAX_LENGTH, '');
        return [
          {
            dataSlotKey,
            operator: narrowToEnum(
              typeof r.operator === 'string' ? r.operator : '',
              SCOPE_RULE_OPERATORS,
              'exists'
            ),
            value: rawValue.length > 0 ? rawValue : null,
            action: narrowToEnum(
              typeof r.action === 'string' ? r.action : '',
              SCOPE_RULE_ACTIONS,
              'include'
            ),
            topicKey,
            rationale: asText(r.rationale, SCOPE_RATIONALE_MAX_LENGTH, ''),
            ...(sourceQuote.length > 0 ? { sourceQuote } : {}),
          },
        ];
      })
    : [];

  const gaps: ProposedGap[] = Array.isArray(value.gaps)
    ? value.gaps.flatMap((g): ProposedGap[] => {
        if (!isRecord(g)) return [];
        const sourceQuote = asText(g.sourceQuote, TOPIC_CRITERIA_MAX_LENGTH, '');
        const explanation = asText(g.explanation, SCOPE_RATIONALE_MAX_LENGTH, '');
        if (sourceQuote.length === 0 || explanation.length === 0) return [];
        return [{ sourceQuote, explanation }];
      })
    : [];

  const cap =
    typeof value.maxConditionalTopics === 'number'
      ? Math.round(
          asNumber(
            value.maxConditionalTopics,
            MIN_CONDITIONAL_TOPICS,
            MAX_CONDITIONAL_TOPICS_CEILING,
            DEFAULT_ADAPTIVE_SCOPE_SETTINGS.maxConditionalTopics
          )
        )
      : null;

  // Both lists are constrained to keys the proposal itself carries. A settings key naming a topic
  // that does not exist is inert at runtime (`chooseCheckTopic` and the fallback loop both skip
  // unknown keys) but it reads on the review card as a decision the admin never gets, so it is
  // dropped here rather than shown.
  const proposedKeys = new Set(topics.map((t) => t.key));
  // Filter for membership BEFORE capping. Capping first spends the budget on keys that are about
  // to be discarded, so one stale key ahead of five valid ones would keep only four. The cap is
  // MAX_PROPOSED_SETTING_KEYS rather than a literal so raising it cannot move in one place only.
  const settingKeys = (raw: unknown): string[] =>
    asKeyList(raw)
      .filter((k) => proposedKeys.has(k))
      .slice(0, MAX_PROPOSED_SETTING_KEYS);
  const fallbackTopicKeys = settingKeys(value.fallbackTopicKeys);
  const checkTopicPreference = settingKeys(value.checkTopicPreference);

  return {
    v: 1,
    topics,
    rules,
    gaps,
    ...(cap !== null ? { maxConditionalTopics: cap } : {}),
    ...(fallbackTopicKeys.length > 0 ? { fallbackTopicKeys } : {}),
    ...(checkTopicPreference.length > 0 ? { checkTopicPreference } : {}),
    ...(depthCorrectedKeys.length > 0 ? { depthCorrectedKeys } : {}),
    summary: asText(value.summary, SCOPE_RATIONALE_MAX_LENGTH, ''),
    fromDocument: asBool(value.fromDocument, false),
    generatedAt: asText(value.generatedAt, 40, ''),
  };
}

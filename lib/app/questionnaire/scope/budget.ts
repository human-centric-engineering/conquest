/**
 * What an interview costs a respondent, in seconds (C7) — pure, no I/O.
 *
 * `maxConditionalTopics` controls **breadth**: how many areas an interview may cover. It was
 * standing in for **duration**, and it cannot do that job. The Merlin5 workbook derives its famous
 * "no more than three routed sections" from arithmetic, not preference:
 *
 * ```
 * Mandatory floor:  S0 (160) + S1 (8) + S4 (8) + S15 (90)  = 266s
 * Remaining for routed sections                            = 334s
 * The three most expensive routed sections (S14+S11+S2)    = 332s ← exactly fits
 * A fourth, even the cheapest (S6/S8/S9 at 61s)            = 393s ✗
 * ```
 *
 * Three is the answer for *that* instrument at *that* budget. A topic of ten likerts and a topic of
 * three cost a respondent wildly different amounts of attention, so a count is not a length — and a
 * client who says "make it fifteen minutes" needs a code change rather than a setting.
 *
 * This module prices the instrument so the arithmetic can be shown, and — since C7b (F17.9) —
 * enforced: `scope/guardrails.ts` fits the plan to what is left of the budget using these numbers.
 * It is deliberately estimation, not measurement: real durations vary by respondent, question
 * difficulty and how much someone wants to talk. The estimate's job is to make relative cost
 * visible and the fit decidable, not to predict a stopwatch.
 */

import { QUESTION_TYPES, type QuestionType } from '@/lib/app/questionnaire/types';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { membersAtDepth } from '@/lib/app/questionnaire/scope/resolve';
import {
  ALWAYS_PHASES,
  DEFAULT_SECONDS_PER_DATA_SLOT,
  type AdaptiveScopeSettings,
  type Topic,
  type TopicDepth,
} from '@/lib/app/questionnaire/scope/types';

/**
 * Seconds one item of each question type costs, before any per-version override.
 *
 * The two anchors are the client's own: **8s for a likert** (a rating on a scale you have already
 * read once) and **45s for free text** (a considered sentence typed or spoken). Everything else is
 * interpolated between them by how much of a decision the type actually asks for — a boolean is
 * faster than a likert because there is no scale to read; a multi-choice is slower than a single
 * because it does not end at the first match; a matrix is priced per ROW at likert cost by the
 * caller, so its own entry here is the per-row figure.
 */
export const DEFAULT_SECONDS_PER_TYPE: Record<QuestionType, number> = {
  free_text: 45,
  likert: 8,
  matrix: 8,
  single_choice: 10,
  multi_choice: 14,
  numeric: 10,
  date: 8,
  boolean: 5,
};

/** What one topic costs at each depth. Both are needed: the planner may seat a topic either way. */
export interface TopicCost {
  /** Every member. */
  full: number;
  /** The members a `light` topic actually asks — the blind-spot sample, not the whole area. */
  light: number;
}

/** Per-key second costs for one version, resolved once and reused for every topic. */
export interface ItemSeconds {
  byQuestionKey: ReadonlyMap<string, number>;
  byDataSlotKey: ReadonlyMap<string, number>;
}

/** A question's identity for pricing: its key and its type. */
export interface PricedQuestion {
  key: string;
  type: string;
  /**
   * For a `matrix`, how many rows it has — each row is a rating the respondent gives, so a 6-row
   * grid costs six ratings and not one. Ignored for every other type.
   */
  rowCount?: number;
}

/** Resolve the seconds map for a version's items. */
export function itemSeconds(
  questions: readonly PricedQuestion[],
  dataSlotKeys: readonly string[],
  settings: AdaptiveScopeSettings
): ItemSeconds {
  const byQuestionKey = new Map<string, number>();
  for (const q of questions) {
    byQuestionKey.set(q.key, secondsForQuestion(q, settings));
  }
  const byDataSlotKey = new Map<string, number>();
  const slotCost = settings.secondsPerDataSlot || DEFAULT_SECONDS_PER_DATA_SLOT;
  for (const key of dataSlotKeys) byDataSlotKey.set(key, slotCost);
  return { byQuestionKey, byDataSlotKey };
}

/** Seconds for one question: the version override, else the default for its type, times its rows. */
function secondsForQuestion(question: PricedQuestion, settings: AdaptiveScopeSettings): number {
  const type = asQuestionType(question.type);
  const perItem = settings.secondsPerQuestionType[type] ?? DEFAULT_SECONDS_PER_TYPE[type];
  if (type !== 'matrix') return perItem;
  // A matrix is N ratings wearing one prompt. Pricing it as a single item is how a 12-row grid ends
  // up looking cheaper than the three likerts beside it.
  const rows = Math.max(1, Math.round(question.rowCount ?? 1));
  return perItem * rows;
}

/**
 * How many rows a matrix asks a respondent to rate, from its stored `typeConfig`.
 *
 * Lives beside the pricing rather than at either call site: the topics route reads it to show an
 * author what a grid costs, and the planner reads it to decide whether one fits. Two copies of
 * "what counts as a row" is two answers to the same question.
 */
export function matrixRowCount(typeConfig: unknown): number {
  const parsed = typeConfigSchemaFor('matrix').safeParse(typeConfig);
  if (!parsed.success) return 1;
  const cfg = parsed.data as { rows?: unknown[] };
  return Array.isArray(cfg.rows) ? Math.max(1, cfg.rows.length) : 1;
}

/** An unrecognised stored type prices as free text — the most expensive guess, deliberately. */
function asQuestionType(value: string): QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as QuestionType)
    : 'free_text';
}

/** Sum the seconds for a set of member keys. A key with no price contributes nothing. */
function sumKeys(keys: readonly string[], seconds: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const key of keys) total += seconds.get(key) ?? 0;
  return total;
}

/** What one topic costs at a given depth. */
export function topicSeconds(
  topic: Topic,
  depth: TopicDepth,
  seconds: ItemSeconds,
  weights?: {
    byQuestionKey?: ReadonlyMap<string, number>;
    byDataSlotKey?: ReadonlyMap<string, number>;
  }
): number {
  // Priced through the SAME resolver the interview uses, so a light topic's cost is the cost of the
  // members it will actually ask. Duplicating "the top two by weight" here is how a cost model and
  // a resolver drift apart without anyone noticing.
  const questionKeys = membersAtDepth(topic.members.questionKeys, depth, weights?.byQuestionKey);
  const dataSlotKeys = membersAtDepth(topic.members.dataSlotKeys, depth, weights?.byDataSlotKey);
  return (
    sumKeys(questionKeys, seconds.byQuestionKey) + sumKeys(dataSlotKeys, seconds.byDataSlotKey)
  );
}

/** Cost every topic at both depths, keyed by topic key. */
export function estimateTopicCosts(
  topics: readonly Topic[],
  seconds: ItemSeconds,
  weights?: {
    byQuestionKey?: ReadonlyMap<string, number>;
    byDataSlotKey?: ReadonlyMap<string, number>;
  }
): Map<string, TopicCost> {
  const out = new Map<string, TopicCost>();
  for (const topic of topics) {
    out.set(topic.key, {
      full: topicSeconds(topic, 'full', seconds, weights),
      light: topicSeconds(topic, 'light', seconds, weights),
    });
  }
  return out;
}

/**
 * What a set of seated topics costs at the depths they were seated at.
 *
 * The plan's own arithmetic — `light` and `full` are priced differently, which is the entire reason
 * a count could not do this job. A topic with no entry in `costs` contributes nothing: an unpriced
 * topic is one that resolves to no members, and charging a guess for it would drop a real topic to
 * make room for an imaginary one.
 */
export function plannedSeconds(
  planned: readonly { key: string; depth: TopicDepth }[],
  costs: ReadonlyMap<string, TopicCost>
): number {
  let total = 0;
  for (const topic of planned) {
    const cost = costs.get(topic.key);
    if (!cost) continue;
    total += topic.depth === 'light' ? cost.light : cost.full;
  }
  return total;
}

/**
 * The mandatory floor: what every interview costs before a single routing decision is taken.
 *
 * The always-run phases (`opening`, `core`, `closing`) are not optional, so their cost is not
 * available to spend. Subtracting it from the budget is what turns "600 seconds" into the number an
 * author actually has to allocate.
 */
export function alwaysTopicSeconds(
  topics: readonly Topic[],
  costs: ReadonlyMap<string, TopicCost>
): number {
  let total = 0;
  for (const topic of topics) {
    if (!ALWAYS_PHASES.includes(topic.phase)) continue;
    // Honour the authored depth here too. `resolveScope` applies `depth` to always-run topics as
    // well as routed ones, and the editor offers the selector for every phase — so charging `full`
    // for a `light` opening overstated the mandatory floor, under-reported the routed allowance,
    // dropped topics from `fitToBudget` that would have fitted, and could raise a
    // `budget_below_floor` error that blocks launch on a budget that was in fact sufficient.
    const cost = costs.get(topic.key);
    total += (topic.depth === 'light' ? cost?.light : cost?.full) ?? 0;
  }
  return total;
}

/** What remains for routed topics after the floor. Never negative — an over-floor budget has 0 left. */
export function routedAllowanceSeconds(budgetSeconds: number, alwaysSeconds: number): number {
  if (budgetSeconds <= 0) return 0;
  return Math.max(0, budgetSeconds - alwaysSeconds);
}

/**
 * Render seconds the way an author reads them: `"8s"`, `"1m 40s"`, `"10m"`.
 *
 * Lives here rather than in the component because the same string appears in the topic list, the
 * settings readout and the plan record, and three formatters would drift.
 */
export function formatSeconds(total: number): string {
  const seconds = Math.max(0, Math.round(total));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

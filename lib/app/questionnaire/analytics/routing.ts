/**
 * Routing quality (F17.16) — what the planner actually did, across a version's interviews.
 *
 * ## Why this exists
 *
 * Every plan is recorded, and every respondent amendment is recorded twice — on
 * `InterviewPlan.amendments` and as a `source: 'respondent'` topic — specifically so routing
 * quality could be measured. Nothing read either. So the two failures that matter most to an
 * adaptive instrument were both invisible:
 *
 * - **A criteria sentence that never fires.** The topic simply never appears in anyone's interview.
 *   There is no error, no empty state, no report — the instrument just quietly asks less than its
 *   author believes it asks.
 * - **A criteria sentence respondents keep correcting.** They ask for a topic the planner left out.
 *   That is the sharpest available evidence that a version's criteria are wrong, and it was sitting
 *   in a JSON column nobody queried.
 *
 * ## Counting rules
 *
 * **A respondent's correction is never a planner success.** `selected` excludes `source:
 * 'respondent'` entirely and the amendment is counted on its own axis. Folding them together would
 * make a version's criteria look better the worse they got, which is the failure
 * `InterviewPlan.amendments` was kept as a separate record to prevent.
 *
 * **`excluded` means "left out and stayed out".** `applyAmendment` removes an amended topic from
 * the plan's `excluded` list, so the two counts partition the topics the planner did not seat:
 * `excluded` is the decisions that held, `amended` is the ones the respondent overturned.
 *
 * ## What never crosses the boundary
 *
 * A plan carries respondent free text in two places — `amendments[].request` (their own words) and
 * the `rationale` written from it. This module reads neither. Counts and topic keys only, on the
 * same principle F17.14 settled for the plan preview: an authoring surface is not a place to put
 * respondent answers.
 */

import { prisma } from '@/lib/db/client';
import { isCohortSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import {
  roundSessionFilter,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  AnalyticsRange,
  RoutingAnalyticsResult,
  RoutingFinding,
  RoutingTopicRow,
} from '@/lib/app/questionnaire/analytics/views';
import {
  narrowInterviewPlan,
  type InterviewPlan,
  type ScopeDecisionSource,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { loadTopics } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/**
 * Plans needed before a finding is stated at all.
 *
 * Separate from `K_ANONYMITY_THRESHOLD` on purpose, and equal to it only by coincidence: that one
 * governs **disclosure** (how few respondents make a count re-identifying), this one governs
 * **inference** (how few interviews make "it never fires" mean anything). Sharing a constant would
 * let a privacy decision silently change what counts as evidence.
 */
export const ROUTING_FINDING_MIN_PLANS = 5;

/**
 * Most plans one read will carry.
 *
 * The card fetches on mount, so this runs on an ordinary Topics-tab visit; a version with tens of
 * thousands of sessions in the window would otherwise pull every plan blob into memory to compute a
 * handful of counts. The newest plans are the ones that describe the criteria as they stand, and
 * the result says when it truncated rather than presenting a sample as the whole.
 */
export const ROUTING_PLAN_READ_CAP = 2_000;

/** Share of plans a topic must be amended into before that reads as a pattern rather than a one-off. */
const AMENDMENT_PATTERN_SHARE = 0.2;

/** Share of a topic's exclusions the budget must own before the budget, not the criteria, is deciding. */
const BUDGET_PATTERN_SHARE = 0.5;

/**
 * Written out rather than built from `SCOPE_DECISION_SOURCES`, so the compiler enforces the set.
 * A source added to the vocabulary and forgotten here becomes a build error instead of an
 * `undefined` that increments to `NaN` and quietly empties a column.
 */
function emptySourceCounts(): Record<ScopeDecisionSource, number> {
  return { phase: 0, llm: 0, fallback: 0, check: 0, respondent: 0, budget: 0, early: 0 };
}

/**
 * Aggregate a set of plans into the routing view. Pure — no Prisma, no dates of its own.
 *
 * Exported so the arithmetic can be tested without a database, the way
 * `assembleQuestionDistributions` is.
 */
export function assembleRoutingAnalytics(
  plans: readonly InterviewPlan[],
  topics: readonly Topic[],
  meta: { versionId: string; range: AnalyticsRange }
): RoutingAnalyticsResult {
  const byKey = new Map<string, RoutingTopicRow>();
  const topicByKey = new Map(topics.map((t) => [t.key, t] as const));

  const row = (key: string): RoutingTopicRow => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const topic = topicByKey.get(key);
    const created: RoutingTopicRow = {
      key,
      label: topic?.label ?? key,
      phase: topic?.phase ?? null,
      selected: 0,
      chosen: 0,
      sampled: 0,
      bySource: emptySourceCounts(),
      excluded: 0,
      droppedByBudget: 0,
      amended: 0,
      chosenRate: 0,
    };
    byKey.set(key, created);
    return created;
  };

  // Every conditional topic on the version gets a row even if no plan ever mentioned it — a topic
  // that appears in nothing is exactly the case the "never fires" finding is for, and it cannot be
  // discovered from the plans alone.
  for (const topic of topics) {
    if (topic.phase === 'conditional') row(topic.key);
  }

  let amendedPlans = 0;
  let fallbackPlans = 0;
  let checkTopicPlans = 0;
  let confidenceTotal = 0;

  for (const plan of plans) {
    confidenceTotal += plan.confidence;
    if (plan.source === 'fallback') fallbackPlans += 1;
    if (plan.checkTopicKey) checkTopicPlans += 1;

    // Both records of an amendment, unioned: `amendments` is the richer one but is absent on plans
    // written before it shipped, where the `source: 'respondent'` topic is the only trace.
    const amendedKeys = new Set<string>((plan.amendments ?? []).map((a) => a.key));
    for (const topic of plan.topics) {
      if (topic.source === 'respondent') amendedKeys.add(topic.key);
    }
    if (amendedKeys.size > 0) amendedPlans += 1;
    for (const key of amendedKeys) row(key).amended += 1;

    for (const topic of plan.topics) {
      if (amendedKeys.has(topic.key)) continue;
      const target = row(topic.key);
      target.selected += 1;
      target.bySource[topic.source] += 1;
      // `check` is the one source that means the OPPOSITE of selection — the topic is sampled
      // because nothing chose it. `fallback` is likewise not a judgement about this topic; it is
      // what happens when there was no signal to judge on at all.
      //
      // `early` (F17.36) is deliberately NOT counted as `chosen` either, and this is the same rule
      // `respondent` follows above. An early seat the final planner would also have chosen is a
      // planner success; one it would not have chosen is not, and counting them together would make
      // the planner look better the more aggressively the early-seating floor was tuned. The
      // separate count lives in `bySource.early`.
      if (topic.source === 'llm') target.chosen += 1;
      else if (topic.source === 'check') target.sampled += 1;
    }

    for (const excluded of plan.excluded) {
      const target = row(excluded.key);
      target.excluded += 1;
      if (excluded.source === 'budget') target.droppedByBudget += 1;
    }
  }

  const planCount = plans.length;
  const rows = [...byKey.values()];
  for (const r of rows) r.chosenRate = planCount > 0 ? r.chosen / planCount : 0;
  rows.sort((a, b) => b.chosen - a.chosen || a.key.localeCompare(b.key));

  return {
    versionId: meta.versionId,
    range: meta.range,
    plans: planCount,
    amendedPlans,
    fallbackPlans,
    checkTopicPlans,
    meanConfidence: planCount > 0 ? confidenceTotal / planCount : 0,
    topics: rows,
    findings: deriveFindings(rows, planCount, topicByKey),
    suppressed: false,
    truncated: false,
  };
}

/**
 * Turn the counts into the four things worth telling an author.
 *
 * Only ever about CONDITIONAL topics that still exist: an always-run topic has no criteria to be
 * wrong, and a deleted one cannot be edited. Silent below {@link ROUTING_FINDING_MIN_PLANS}, where
 * every one of these would be an accident of a small sample.
 */
function deriveFindings(
  rows: readonly RoutingTopicRow[],
  plans: number,
  topicByKey: ReadonlyMap<string, Topic>
): RoutingFinding[] {
  if (plans < ROUTING_FINDING_MIN_PLANS) return [];
  const findings: RoutingFinding[] = [];

  for (const r of rows) {
    const topic = topicByKey.get(r.key);
    if (!topic || topic.phase !== 'conditional') continue;

    if (r.chosen === 0 && r.amended === 0) {
      const sampled =
        r.sampled > 0
          ? ` It was sampled as a blind-spot check ${r.sampled} time${r.sampled === 1 ? '' : 's'}, which is not your criteria firing.`
          : '';
      findings.push({
        code: 'criteria_never_fires',
        topicKey: r.key,
        message: `"${r.label}" was never chosen by your criteria or rules across the last ${plans} interviews.${sampled} Either the criteria never match what respondents say, or the area genuinely has not come up yet.`,
      });
    } else if (r.chosen === plans) {
      findings.push({
        code: 'criteria_always_fires',
        topicKey: r.key,
        message: `"${r.label}" was chosen in all ${plans} interviews, so it is effectively an always-ask topic that spends one of your conditional slots. Move it to "Always ask" to free the slot for a real decision.`,
      });
    }

    if (r.amended >= 2 && r.amended / plans >= AMENDMENT_PATTERN_SHARE) {
      findings.push({
        code: 'respondents_keep_adding',
        topicKey: r.key,
        message: `Respondents asked for "${r.label}" themselves in ${r.amended} of ${plans} interviews after it was left out. That is the sharpest sign its criteria are too narrow.`,
      });
    }

    if (
      r.droppedByBudget >= 2 &&
      r.droppedByBudget / Math.max(1, r.excluded) >= BUDGET_PATTERN_SHARE
    ) {
      findings.push({
        code: 'budget_decides',
        topicKey: r.key,
        message: `"${r.label}" was chosen by the agent and then dropped for time in ${r.droppedByBudget} interviews. Your time budget, not your criteria, is deciding this one.`,
      });
    }
  }

  return findings;
}

/**
 * Routing quality for a version over the window.
 *
 * Counts non-preview sessions that reached a plan. Suppressed when the cohort is non-empty but
 * below the k-anonymity threshold, because a per-topic count over two interviews describes those
 * two respondents' plans: the rows and findings go, and every aggregate is zeroed EXCEPT `plans`
 * itself. That one stays so the surface can say how far off the threshold it is — a cohort size is
 * what the funnel already reports, and "3 interviews so far" identifies nobody where "topic X was
 * chosen in 3 of 3" would.
 */
export async function getRoutingAnalytics(scope: AnalyticsScope): Promise<RoutingAnalyticsResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  const [sessions, topics] = await Promise.all([
    prisma.appQuestionnaireSession.findMany({
      where: {
        versionId: scope.versionId,
        isPreview: false,
        createdAt: { gte: scope.from, lt: scope.to },
        ...roundSessionFilter(scope.roundId),
      },
      // Newest first, so a truncated read describes the criteria as they stand rather than as they
      // were. One over the cap is how truncation is detected without a second count query.
      orderBy: { createdAt: 'desc' },
      take: ROUTING_PLAN_READ_CAP + 1,
      select: { interviewPlan: true },
    }),
    loadTopics(scope.versionId),
  ]);

  // "Has a plan" is decided here rather than in the `where`, because filtering a nullable Json
  // column needs `Prisma.DbNull` — a value import `lib/app/**` is not allowed to make, by the rule
  // that keeps this layer storage-agnostic. The narrower rejects `null` anyway, so the only cost is
  // reading the planless rows, and a session without a plan carries no blob to read.
  //
  // A row whose blob no longer narrows is dropped rather than guessed at: a half-read plan would
  // under-count one topic and over-count another, which is worse than a smaller sample.
  const plans = sessions
    .map((s) => narrowInterviewPlan(s.interviewPlan))
    .filter((p): p is InterviewPlan => p !== null)
    .slice(0, ROUTING_PLAN_READ_CAP);

  const result = {
    ...assembleRoutingAnalytics(plans, topics, { versionId: scope.versionId, range }),
    truncated: sessions.length > ROUTING_PLAN_READ_CAP,
  };
  if (!isCohortSuppressed(plans.length)) return result;

  return {
    ...result,
    amendedPlans: 0,
    fallbackPlans: 0,
    checkTopicPlans: 0,
    meanConfidence: 0,
    topics: [],
    findings: [],
    suppressed: true,
  };
}

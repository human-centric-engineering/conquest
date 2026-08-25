/**
 * Conditional Topics (P17) — the shapes the admin surfaces read.
 *
 * One declaration of what `GET …/versions/:vid/topics` returns, shared by the server fetcher
 * (`workspace-data.ts`), the Topics tab page, and the client panel. Without it the payload would be
 * re-typed at each of the three seams and could drift silently — the route is the only writer.
 *
 * Pure: no Prisma, no Next. Safe to import from client components.
 */

import type { TopicCost } from '@/lib/app/questionnaire/scope/budget';
import type { ScopeCandidacyVerdict } from '@/lib/app/questionnaire/scope/candidacy-schema';
import {
  NEGATIVE_SCOPE_OPERATOR,
  type ConditionalTopicsSettings,
  type InterviewPlan,
  type ProposedTopicSet,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { ScopeIssue } from '@/lib/app/questionnaire/scope/validate';
import type { SourceDocumentView } from '@/lib/app/questionnaire/ingestion/source-documents';

/** One question the membership picker can offer, with the section it sits in. */
export interface TopicQuestionRef {
  key: string;
  prompt: string;
  sectionTitle: string;
  /** The question type — what its time estimate is derived from (C7). */
  type: string;
  /** Estimated seconds this question costs a respondent. */
  estimatedSeconds: number;
  /**
   * The authored weight, carried so a client surface can name the members a `light` topic samples.
   *
   * `light` keeps the highest-weight members, so "which two does it ask" is unanswerable without
   * this — and a surface that showed the light DURATION but guessed at the light MEMBERS would
   * print two numbers that do not add up. The picker ignores it; the routing map reads it.
   */
  weight: number;
}

/** One data slot the membership picker can offer. */
export interface TopicDataSlotRef {
  key: string;
  name: string;
  theme: string;
  /** Estimated seconds this slot costs a respondent (C7). */
  estimatedSeconds: number;
  /** The authored weight. Same purpose as {@link TopicQuestionRef.weight}. */
  weight: number;
}

/**
 * What this version's interview costs, in seconds (C7).
 *
 * Computed server-side for the same reason `issues` is: the arithmetic that decides whether a plan
 * fits must have exactly one implementation, or the number an author reads on the Topics tab and
 * the number the planner works to will disagree — and the whole point of showing it is that an
 * author can trust it.
 */
export interface TopicsCostView {
  /** The version's budget in seconds, or 0 when none is set. */
  budgetSeconds: number;
  /** What the always-run phases cost — spent before any routing decision is taken. */
  alwaysSeconds: number;
  /** What is left for routed topics: `budgetSeconds - alwaysSeconds`, floored at 0. */
  routedAllowanceSeconds: number;
  /** Per-topic cost at each depth, keyed by topic key. A plain object — this crosses the wire. */
  byTopicKey: Record<string, TopicCost>;
}

/**
 * Everything the Topics tab needs in one payload: the topics, the resolved settings, the coherence
 * findings computed server-side, and the key inventory the membership pickers offer.
 *
 * The findings are computed on the server rather than in the browser because the launch gate runs
 * the same `validateConditionalTopics` — one evaluation, so the page and the gate can never disagree
 * about whether a version is coherent.
 */
export interface TopicsPayload {
  topics: Topic[];
  settings: ConditionalTopicsSettings;
  issues: ScopeIssue[];
  inventory: {
    questions: TopicQuestionRef[];
    dataSlots: TopicDataSlotRef[];
  };
  /**
   * The time arithmetic (C7): what each topic costs, what the mandatory floor is, and what is left
   * to allocate. Always present — with no budget set, `budgetSeconds` is 0 and the per-topic costs
   * still describe the instrument, which is the half an author benefits from either way.
   */
  costs: TopicsCostView;
  /**
   * The Routing Analyst's pending proposal, or null.
   *
   * Carried in the same payload as the live set rather than fetched separately, because the review
   * surface's whole job is to show the two side by side: "this proposal replaces four of the topics
   * you have" is the sentence an admin needs, and it cannot be written from either half alone.
   */
  draft: ProposedTopicSet | null;
  /**
   * What the plan-preview form needs to render (F17.14). Derived from the same topics and rules
   * carried above, server-side, so "which questions are in the opening" has one implementation.
   */
  preview: PlanPreviewForm;
  /**
   * The ingestion-time candidacy verdict (F17.19 Phase 1), or null when the version was never
   * checked, was ineligible at check time, or the document did not read as a routing candidate.
   */
  candidacy: ScopeCandidacyVerdict | null;
  /**
   * True when the Routing Analyst should run automatically, right now, because Phase 1 flagged
   * this document and nothing has acted on it since (F17.19 Phase 3). The client fires it at most
   * once — the next time this GET is called, either a draft will exist or an `AppAiRun` will
   * record the attempt, and this flips back to false.
   */
  autoTriggerPending: boolean;
  /**
   * How much of the instrument the topic set actually claims.
   *
   * Server-computed from `uncoveredQuestionKeys` — the SAME function the `orphaned_questions`
   * finding uses — so the number a persistent header shows and the number the issue list shows
   * cannot disagree. Deriving it in the browser was the alternative and it is subtly wrong: the
   * finding suppresses itself when a version has no topics at all, so a naive client-side count
   * would report orphans on a version whose issue list is deliberately silent.
   */
  coverage: TopicsCoverage;
  /**
   * Every source document on the version — the instrument it was extracted from, and any
   * supporting documents attached beside it (F17.29).
   *
   * In this payload rather than behind its own fetch, for the reason the list surfaces already
   * follow: the card that lists them sits on this tab, and a per-card `useEffect` fetch would put
   * a second round-trip in front of a list of at most six filenames.
   */
  documents: SourceDocumentView[];
}

/** The `coverage` block of {@link TopicsPayload}. Counts only — the keys stay server-side. */
export interface TopicsCoverage {
  totalQuestions: number;
  uncoveredQuestions: number;
  totalDataSlots: number;
  uncoveredDataSlots: number;
}

/** The empty payload — what a failed fetch degrades to, so a tab renders rather than crashing. */
export const EMPTY_TOPICS_PAYLOAD: Omit<TopicsPayload, 'settings'> = {
  topics: [],
  issues: [],
  inventory: { questions: [], dataSlots: [] },
  costs: { budgetSeconds: 0, alwaysSeconds: 0, routedAllowanceSeconds: 0, byTopicKey: {} },
  draft: null,
  preview: { openingQuestions: [], fillTargets: [] },
  candidacy: null,
  autoTriggerPending: false,
  coverage: {
    totalQuestions: 0,
    uncoveredQuestions: 0,
    totalDataSlots: 0,
    uncoveredDataSlots: 0,
  },
  documents: [],
};

/* -------------------------------------------------------------------------- */
/* The plan preview (F17.14)                                                  */
/* -------------------------------------------------------------------------- */

/** One opening question the preview form offers a box for. */
export interface PreviewOpeningQuestion {
  key: string;
  prompt: string;
}

/** One data slot the preview form offers a value for — and, crucially, lets be left empty. */
export interface PreviewFillTarget {
  key: string;
  name: string;
  /**
   * True when a hard rule tests this slot for ABSENCE (`not_exists`).
   *
   * Surfaced because leaving the box empty is then not an omission but the whole experiment: the
   * veto is the single most valuable thing a preview can demonstrate, and an author who does not
   * know which slot it watches will fill every box out of tidiness and never see it fire.
   */
  watchedByVeto: boolean;
}

/**
 * What the preview form needs to render itself, derived server-side from the version.
 *
 * Part of {@link TopicsPayload} rather than its own fetch: the form's shape is a function of the
 * topics and rules already in that payload, and deriving it in the browser would mean a second
 * implementation of "which questions are in the opening" that could disagree with the planner's.
 */
export interface PlanPreviewForm {
  /** The opening topics' questions, in ordinal order. Empty when no opening topic is authored. */
  openingQuestions: PreviewOpeningQuestion[];
  /** Every data slot in the version, with the veto-watched ones marked. */
  fillTargets: PreviewFillTarget[];
}

/**
 * The dry-run's answer: the plan the current settings would produce, plus what the model itself
 * proposed before the guardrails touched it.
 *
 * The plan already carries most of the trace — `PlannedTopic.source` and `ExcludedTopic.source`
 * name the rule / the model / the fallback / the budget / the check for every topic. The one thing
 * it cannot carry is the difference between "the model never picked this" and "the model picked it
 * and a guardrail took it back", which is exactly the difference an author is trying to see.
 */
export interface PlanPreviewResult {
  plan: InterviewPlan;
  /** The topic keys the model proposed, in its own order. Empty when no model call was made. */
  proposedKeys: string[];
  /** Why no model call happened, when none did — "nothing to decide" is a real answer. */
  skippedModelReason: string | null;
  /** What this dry-run cost, in USD. Shown so an author knows the button is not free. */
  costUsd: number;
}

/**
 * Derive the preview form from the version's own topics, rules and slot inventory.
 *
 * Pure, and server-side by convention (the route calls it) for the same reason `issues` and `costs`
 * are computed there: "which questions are in the opening" is a question the planner already
 * answers one way, and a second answer computed in the browser could disagree with it.
 *
 * Opening questions are listed in topic-ordinal then member order, which is the order the interview
 * would ask them in — an author filling the form top to bottom is reproducing a real opening.
 */
export function buildPlanPreviewForm(
  topics: readonly Topic[],
  settings: ConditionalTopicsSettings,
  dataSlots: readonly TopicDataSlotRef[],
  questionPrompts: ReadonlyMap<string, string>
): PlanPreviewForm {
  const openingQuestions: PreviewOpeningQuestion[] = [];
  const seen = new Set<string>();
  for (const topic of [...topics].sort((a, b) => a.ordinal - b.ordinal)) {
    if (topic.phase !== 'opening') continue;
    for (const key of topic.members.questionKeys) {
      // A member naming a question that no longer exists is skipped, exactly as it is at runtime —
      // showing a box for it would invite an author to answer a question no respondent can be asked.
      const prompt = questionPrompts.get(key);
      if (prompt === undefined || seen.has(key)) continue;
      seen.add(key);
      openingQuestions.push({ key, prompt });
    }
  }

  const vetoed = new Set(
    settings.rules.filter((r) => r.operator === NEGATIVE_SCOPE_OPERATOR).map((r) => r.dataSlotKey)
  );

  return {
    openingQuestions,
    fillTargets: dataSlots.map((slot) => ({
      key: slot.key,
      name: slot.name,
      watchedByVeto: vetoed.has(slot.key),
    })),
  };
}

/**
 * Read-side view types for the F8.1 admin analytics surface.
 *
 * The shapes the three analytics GET endpoints return and the admin UI consumes.
 * Pure types, **client-safe** (no Prisma, no Next) — the route serializers and the
 * `'use client'` panels import the same contract. Dates cross the HTTP boundary as
 * ISO strings, so there are no `Date` objects here.
 *
 * Three surfaces, one shared scope (`AnalyticsRange` echoes the resolved window):
 *   - {@link QuestionDistributionsResult} — per-question answer distributions
 *   - {@link CompletionFunnelResult}      — invited → opened → started → completed
 *   - {@link QuestionnaireCostResult}     — per-version cost actuals from `AiCostLog`
 *
 * Deliberately aggregate-only: free-text answer *values* are never surfaced (only
 * counts/confidence), so F8.1 is PII-safe by construction ahead of F8.3's
 * anonymous-mode hardening.
 */

import type { QuestionType, AnswerProvenance, SessionStatus } from '@/lib/app/questionnaire/types';
import type { TagView } from '@/lib/app/questionnaire/views';

/** The resolved analytics window, echoed back so the UI can label what it shows. */
export interface AnalyticsRange {
  /** Inclusive lower bound, ISO-8601. */
  from: string;
  /** Exclusive upper bound, ISO-8601. */
  to: string;
}

/* ── Per-question distributions ─────────────────────────────────────────── */

/** Answer counts split by how each value was arrived at ({@link AnswerProvenance}). */
export type ProvenanceBreakdown = Record<AnswerProvenance, number>;

/** One bucket of a choice/likert distribution: the option and how often it was chosen. */
export interface ValueBucket {
  /** Stored value (choice slug, or stringified likert integer). */
  value: string;
  /** Human label (choice label, likert bound label, or the value itself). */
  label: string;
  count: number;
}

/** Summary statistics for a numeric question's answers. */
export interface NumericSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

/** One bin of a numeric histogram (half-open `[min, max)`, top bin inclusive). */
export interface HistogramBin {
  label: string;
  min: number;
  max: number;
  count: number;
}

/**
 * The type-appropriate shape of a question's answer distribution. `free_text`
 * carries no value detail by design (PII / not meaningful as a distribution).
 */
export type DistributionDetail =
  | { kind: 'choice'; buckets: ValueBucket[]; otherCount: number }
  | { kind: 'likert'; min: number; max: number; buckets: ValueBucket[]; mean: number | null }
  | { kind: 'numeric'; summary: NumericSummary | null; histogram: HistogramBin[] }
  | {
      kind: 'boolean';
      trueLabel: string;
      falseLabel: string;
      trueCount: number;
      falseCount: number;
    }
  | { kind: 'date'; buckets: { label: string; count: number }[] }
  | { kind: 'free_text' };

/** One question's distribution over the non-preview sessions in scope. */
export interface QuestionDistribution {
  questionId: string;
  key: string;
  prompt: string;
  type: QuestionType;
  sectionTitle: string;
  required: boolean;
  tags: TagView[];
  /** Distinct sessions in scope that answered this question. */
  answeredCount: number;
  /** Sessions in scope that did not answer it (`totalSessions - answeredCount`). */
  unansweredCount: number;
  /** `answeredCount / totalSessions` (0 when there are no sessions). */
  responseRate: number;
  /** Mean of the recorded answer confidences (0–1), or null when none scored. */
  avgConfidence: number | null;
  provenance: ProvenanceBreakdown;
  detail: DistributionDetail;
}

export interface QuestionDistributionsResult {
  versionId: string;
  range: AnalyticsRange;
  /** Non-preview sessions in scope — the denominator for every response rate. */
  totalSessions: number;
  /** Of those, how many reached `completed`. */
  completedSessions: number;
  questions: QuestionDistribution[];
}

/* ── Completion funnel ──────────────────────────────────────────────────── */

export type FunnelStageKey = 'invited' | 'opened' | 'started' | 'completed';

export interface FunnelStage {
  key: FunnelStageKey;
  label: string;
  count: number;
  /** Absolute drop from the previous stage (0 for the first stage). */
  dropoff: number;
  /** Fraction of the first stage (`invited`) retained here, 0–1. */
  retention: number;
  /** Conversion from the immediately previous stage, 0–1 (1 for the first). */
  conversionFromPrev: number;
}

export interface CompletionFunnelResult {
  versionId: string;
  range: AnalyticsRange;
  /** invited → opened → started → completed, in order. */
  stages: FunnelStage[];
  /**
   * Respondent sessions with no invitation (anonymous / public link). They enter
   * the journey at "started", so they're reported separately rather than folded
   * into the invite funnel (which would misstate invited-stage retention).
   */
  anonymous: {
    started: number;
    completed: number;
  };
}

/* ── Cost actuals ───────────────────────────────────────────────────────── */

/** Spend grouped by the capability (or LLM operation) that incurred it. */
export interface CostCapabilityBucket {
  key: string;
  label: string;
  costUsd: number;
  callCount: number;
}

/** A single day's total questionnaire spend (zero-spend days omitted). */
export interface CostDayPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  costUsd: number;
}

/** One respondent session's total spend, for the top-spenders table. */
export interface SessionCostRow {
  sessionId: string;
  status: SessionStatus;
  costUsd: number;
  createdAt: string;
}

export interface QuestionnaireCostResult {
  versionId: string;
  range: AnalyticsRange;
  totalCostUsd: number;
  /** Spend on live respondent turns (attributed via `metadata.appQuestionnaireSessionId`). */
  runtimeCostUsd: number;
  /** Design-time spend: structure extraction + evaluation (attributed via `metadata.versionId`). */
  designTimeCostUsd: number;
  byCapability: CostCapabilityBucket[];
  /** Daily total spend across the window, ascending. */
  trend: CostDayPoint[];
  /** Highest-spend respondent sessions, descending (capped). */
  topSessions: SessionCostRow[];
}

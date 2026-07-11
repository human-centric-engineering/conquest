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
import type { AgentCallTrace } from '@/lib/app/questionnaire/inspector/types';

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
 * `suppressed` carries none either — the whole surface is below the k-anonymity
 * threshold (F8.3), so no per-question detail is emitted.
 */
export type DistributionDetail =
  | { kind: 'choice'; buckets: ValueBucket[]; otherCount: number }
  | { kind: 'likert'; min: number; max: number; buckets: ValueBucket[]; mean: number | null }
  | {
      /** A rating grid: one likert-shaped distribution per row, all sharing the scale. */
      kind: 'matrix';
      min: number;
      max: number;
      rows: { key: string; label: string; buckets: ValueBucket[]; mean: number | null }[];
    }
  | { kind: 'numeric'; summary: NumericSummary | null; histogram: HistogramBin[] }
  | {
      kind: 'boolean';
      trueLabel: string;
      falseLabel: string;
      trueCount: number;
      falseCount: number;
    }
  | { kind: 'date'; buckets: { label: string; count: number }[] }
  | { kind: 'free_text' }
  | { kind: 'suppressed' };

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
  /**
   * True when the cohort is non-empty but below the k-anonymity threshold
   * ({@link K_ANONYMITY_THRESHOLD}): per-question `detail` is withheld (every question's
   * `detail.kind` is `suppressed` and its counts are zeroed) so a tiny sample can't
   * re-identify a respondent. F8.3, applied at the aggregator boundary.
   */
  suppressed: boolean;
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
  /**
   * True when the funnel cohort is non-empty but below the k-anonymity threshold
   * ({@link K_ANONYMITY_THRESHOLD}): all stage counts and anonymous counts are zeroed so
   * a tiny cohort can't re-identify who reached a stage. F8.3, at the aggregator.
   */
  suppressed: boolean;
}

/* ── Safeguarding (sensitivity awareness) ───────────────────────────────── */

/**
 * A lightweight safeguarding signal for the analytics tab (sensitivity awareness): how many
 * sessions in the window flagged a sensitive disclosure, and how many were serious (high
 * severity). COUNTS ONLY — never a summary or a session identity (those never cross the analytics
 * boundary). `suppressed` zeroes the counts when the non-preview session cohort is non-empty but
 * below {@link K_ANONYMITY_THRESHOLD}, since "1 of 3 respondents flagged" is itself re-identifying.
 */
export interface SafeguardingSummary {
  versionId: string;
  range: AnalyticsRange;
  /** Sessions with any remembered disclosure (`sensitivityLevel` set). */
  flagged: number;
  /** Sessions whose running-max severity reached `high` (a serious disclosure). */
  serious: number;
  suppressed: boolean;
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
  /** Highest-spend respondent sessions, descending (capped). Empty when suppressed. */
  topSessions: SessionCostRow[];
  /**
   * True when the per-session spend table was withheld (F8.3): the version is anonymous
   * (session ids are a re-identification handle), or the cohort is below the k-anonymity
   * threshold ({@link K_ANONYMITY_THRESHOLD}). Aggregate spend (total / by-capability /
   * trend) is always returned — it carries no per-respondent identity.
   */
  topSessionsSuppressed: boolean;
}

/* ── Diagnostics (per-invitation telemetry + errors) ───────────────────────
 *
 * The Diagnostics surface answers "what happened — and what went wrong — for this invitee?".
 * Unlike the aggregate analytics above, it is an admin DEBUG tool keyed on the invitation, so it
 * deliberately does NOT apply low-N (k-anonymity) suppression — an admin debugging a 2-person pilot
 * still needs the per-invitee view, and they already know whom they invited. It DOES honour the
 * version's `anonymousMode` opt-in: when on, `identitySuppressed` is true and the email/name are
 * withheld (the UI falls back to the invitation short-id), while the operational telemetry + errors
 * still show. */

/** Aggregate telemetry + error tallies for a version over the window. */
export interface DiagnosticsTotals {
  /** Non-preview sessions in scope. */
  sessions: number;
  /** Recorded turns across those sessions in the window. */
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Mean / 95th-percentile end-to-end turn wall-clock (ms); null when no turn recorded a duration. */
  avgTurnMs: number | null;
  p95TurnMs: number | null;
  /** Total diagnostics rows recorded for the version in the window. */
  errorCount: number;
  /** Split of `errorCount` by severity. */
  errorsBySeverity: { error: number; warning: number; info: number };
}

/** One row of the per-invitation Diagnostics table (plus a synthetic "no invitation" group). */
export interface InvitationDiagnosticsRow {
  /** The invitation id, or `null` for the synthetic walk-up / public "(no invitation)" group. */
  invitationId: string | null;
  /** Withheld (null) under `anonymousMode` or for the no-invitation group. */
  email: string | null;
  name: string | null;
  /** Invitation lifecycle status (pending → sent → opened → registered → started → completed; or
   *  revoked). Null for the no-invitation group. */
  status: string | null;
  /** Lifecycle timestamps, ISO-8601 or null. */
  sentAt: string | null;
  openedAt: string | null;
  registeredAt: string | null;
  /** Sessions this invitation produced (usually one). */
  sessionCount: number;
  /** Distinct session statuses across those sessions. */
  sessionStatuses: SessionStatus[];
  turns: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  avgTurnMs: number | null;
  errorCount: number;
  /** Most recent turn or error timestamp for this invitation, ISO-8601 or null. */
  lastActivityAt: string | null;
}

export interface VersionDiagnosticsResult {
  versionId: string;
  range: AnalyticsRange;
  totals: DiagnosticsTotals;
  invitations: InvitationDiagnosticsRow[];
  /** True when `anonymousMode` is on: identity (email/name) is withheld from every row. */
  identitySuppressed: boolean;
}

/* ── Diagnostics drill-down (one invitation) ──────────────────────────────── */

/** One persisted turn's telemetry for the drill-down timeline. */
export interface DiagnosticsTurnRow {
  ordinal: number;
  createdAt: string;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  /** Capability dispatches this turn made (`{ slug, success, code?, latencyMs? }`). */
  toolCalls: unknown;
  /** Side-band notices (`{ code, message }`). */
  warnings: unknown;
  /** The deep-dive: every LLM/embedding call this turn made, with raw prompt/response. */
  inspectorCalls: AgentCallTrace[];
}

/** One captured diagnostics error/refusal for the drill-down log. */
export interface DiagnosticsErrorRow {
  id: string;
  createdAt: string;
  scope: string;
  stage: string | null;
  severity: string;
  code: string | null;
  message: string;
  stack: string | null;
  turnOrdinal: number | null;
  metadata: unknown;
}

/** One session under an invitation, with its full turn timeline. */
export interface DiagnosticsSessionDetail {
  sessionId: string;
  publicRef: string | null;
  status: SessionStatus;
  isPreview: boolean;
  createdAt: string;
  turns: DiagnosticsTurnRow[];
}

export interface InvitationDiagnosticsResult {
  versionId: string;
  invitationId: string | null;
  /** Withheld (null) under `anonymousMode`. The no-invitation group resolves to null. */
  email: string | null;
  name: string | null;
  status: string | null;
  /** Lifecycle timestamps, ISO-8601 or null. */
  sentAt: string | null;
  openedAt: string | null;
  registeredAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  sessions: DiagnosticsSessionDetail[];
  errors: DiagnosticsErrorRow[];
  totals: {
    turns: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    avgTurnMs: number | null;
    errorCount: number;
  };
  identitySuppressed: boolean;
}

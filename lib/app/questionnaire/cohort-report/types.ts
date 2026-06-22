/**
 * Cohort Report — client-safe view types (report kind `cohort`).
 *
 * The cross-respondent analytical substrate the charts (F14.2), the narrative agents (F14.3) and the
 * admin UI all consume. Pure types, **client-safe** (no Prisma, no Next) — dates cross the HTTP
 * boundary as ISO strings, so there are no `Date` objects here. Deliberately aggregate-only and
 * k-anonymity-suppressed at the data boundary (it reuses the F8.1/F8.3 distribution machinery), so a
 * small demographic segment can never re-identify a respondent.
 */

import type {
  QuestionDistribution,
  ProvenanceBreakdown,
} from '@/lib/app/questionnaire/analytics/views';

/** Where a segmentation dimension comes from: a collected profile field, or cohort subgroup. */
export type SegmentSource = 'profile' | 'subgroup';

/** The shape of the bucket values within a dimension. */
export type SegmentKind = 'select' | 'number' | 'subgroup';

/**
 * A demographic axis the cohort can be split on. `profile` dimensions are the admin's
 * `profileFields` of type `select` (discrete) or `number` (bucketed, e.g. age groups); the single
 * `subgroup` dimension splits by the respondent's cohort subgroup. The narrative agent proposes
 * which dimensions are significant (F14.3); the admin can override.
 */
export interface SegmentDimension {
  /** Profile field `key`, or the sentinel {@link SUBGROUP_DIMENSION_KEY} for the subgroup axis. */
  key: string;
  label: string;
  source: SegmentSource;
  kind: SegmentKind;
}

/** One demographic segment — a bucket within a dimension, with its own distributions. */
export interface CohortSegment {
  /** Bucket key: a `select` option value, a numeric-bucket label, or a subgroup id. */
  value: string;
  label: string;
  /** Non-preview sessions in this segment. */
  totalSessions: number;
  /** Of those, how many reached `completed`. */
  completedSessions: number;
  /** True when `0 < totalSessions < kThreshold`: per-question detail is withheld for this segment. */
  suppressed: boolean;
  /** Per-question distributions over just this segment's sessions (suppressed when too small). */
  questions: QuestionDistribution[];
}

/** All segments for one dimension. */
export interface CohortSegmentation {
  dimension: SegmentDimension;
  segments: CohortSegment[];
}

/* ── Data-slot aggregation (F14.7) ────────────────────────────────────────── */

/**
 * One data slot's cross-respondent aggregate — the semantic substance of the responses (the meat the
 * thematic analysis works from). Aggregate + k-anonymity-safe (counts/rates/confidence/provenance);
 * the raw respondent paraphrases that feed the narrative agent are loaded server-side only, never
 * placed on this client-facing shape.
 */
export interface CohortDataSlotSummary {
  key: string;
  /** 1–4 word slot label. */
  name: string;
  /** Group/theme label. */
  theme: string;
  /** Sessions that filled this slot. */
  filled: number;
  /** `filled / totalSessions`. */
  responseRate: number;
  /** Mean fill confidence (0–1), or null when none recorded. */
  avgConfidence: number | null;
  provenance: ProvenanceBreakdown;
  /** True when the cohort is below the floor — counts withheld. */
  suppressed: boolean;
}

/** One data slot's fill rate within one segment of a dimension. */
export interface CohortDataSlotSegmentValue {
  value: string;
  label: string;
  filled: number;
  totalSessions: number;
  suppressed: boolean;
}

/** One data slot compared across a dimension's segments (fill rate). */
export interface CohortDataSlotBySegment {
  key: string;
  name: string;
  segments: CohortDataSlotSegmentValue[];
}

/** Data-slot fill comparison for one dimension. */
export interface CohortDataSlotByDimension {
  dimensionKey: string;
  dimensionLabel: string;
  slots: CohortDataSlotBySegment[];
}

/** The data-slot aggregate — present only when the version has data slots with fills. */
export interface CohortDataSlots {
  overall: CohortDataSlotSummary[];
  byDimension: CohortDataSlotByDimension[];
}

/* ── Deterministic scoring aggregation (F14.4) ────────────────────────────── */

/** One scale's overall aggregate across the cohort. */
export interface CohortScaleSummary {
  scaleKey: string;
  scaleName: string;
  /** Respondents with this scale scored. */
  respondents: number;
  /** Mean raw score, or null when suppressed (too few). */
  mean: number | null;
  /** Count of respondents per band label (empty when suppressed). */
  bandCounts: { label: string; count: number }[];
  /** True when `0 < respondents < kThreshold` (mean + band detail withheld). */
  suppressed: boolean;
}

/** One scale's mean for one segment of a dimension. */
export interface CohortScaleSegmentValue {
  value: string;
  label: string;
  respondents: number;
  mean: number | null;
  suppressed: boolean;
}

/** One scale compared across a dimension's segments. */
export interface CohortScaleBySegment {
  scaleKey: string;
  scaleName: string;
  segments: CohortScaleSegmentValue[];
}

/** Scored comparison for one dimension. */
export interface CohortScoringByDimension {
  dimensionKey: string;
  dimensionLabel: string;
  scales: CohortScaleBySegment[];
}

/** The deterministic-scoring aggregate, present only when scoring is enabled + a schema exists. */
export interface CohortScoring {
  scales: CohortScaleSummary[];
  byDimension: CohortScoringByDimension[];
}

/**
 * The full cross-respondent analytical substrate for one round + version. Built by
 * `buildCohortDataset`; consumed by charts, the analysis/narrative agents, and the admin UI.
 */
export interface CohortDataset {
  roundId: string;
  roundName: string;
  versionId: string;
  /** Non-preview sessions in the round for this version — the overall denominator. */
  totalSessions: number;
  /** Of those, how many reached `completed`. */
  completedSessions: number;
  /** The k-anonymity floor in force (the analytics {@link K_ANONYMITY_THRESHOLD}). */
  kThreshold: number;
  /** True when the whole round is non-empty but below the floor (overall detail withheld). */
  suppressed: boolean;
  /** True when the version collects no profile (anonymous mode) — no demographic segmentation. */
  anonymous: boolean;
  /** Overall (un-segmented) per-question distributions. */
  overall: QuestionDistribution[];
  /** Per-dimension segmentation; empty when anonymous or there are no eligible dimensions. */
  segmentation: CohortSegmentation[];
  /** Data-slot aggregate (the semantic substance); undefined when the version has no data-slot fills. */
  dataSlots?: CohortDataSlots;
  /** Deterministic scoring aggregate; undefined when scoring is off or no schema is authored. */
  scoring?: CohortScoring;
}

/** Sentinel `SegmentDimension.key` for the cohort-subgroup axis (not a profile field key). */
export const SUBGROUP_DIMENSION_KEY = '__subgroup__';

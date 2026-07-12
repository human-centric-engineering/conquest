/**
 * Cohort Report — dataset builder (report kind `cohort`).
 *
 * `buildCohortDataset` produces the cross-respondent analytical substrate for one round + version:
 * the overall per-question distributions plus per-demographic-segment distributions, segmenting by
 * the questionnaire's own `profileFields` (any `select` or `number` field) and by cohort subgroup.
 *
 * It reuses the F8.1/F8.3 distribution machinery wholesale: one set of three queries (slots,
 * sessions+profile, answers), then {@link assembleQuestionDistributions} is called once for the whole
 * round and again per segment over the matching session subset — so k-anonymity suppression and the
 * type-appropriate detail are computed by exactly the same code at every level. A segment below the
 * floor ({@link K_ANONYMITY_THRESHOLD}) has its detail withheld automatically.
 *
 * Anonymous mode: when the version collects no profile (`anonymousMode`), there is no demographic
 * axis to split on, so segmentation is empty — the report is cohort-level only.
 */

import { prisma } from '@/lib/db/client';
import {
  assembleQuestionDistributions,
  DISTRIBUTION_SLOT_SELECT,
  type AnswerForDistribution,
  type SessionForDistribution,
  type SlotForDistribution,
} from '@/lib/app/questionnaire/analytics/distributions';
import {
  K_ANONYMITY_THRESHOLD,
  isCohortSuppressed,
} from '@/lib/app/questionnaire/analytics/privacy';
import { narrowCohortReportSettings } from '@/lib/app/questionnaire/cohort-report/settings';
import { narrowScoringSchemaContent } from '@/lib/app/questionnaire/scoring/schema-validation';
import { buildScoringInputs, scoreSessions } from '@/lib/app/questionnaire/scoring/compute';
import type { RespondentScores } from '@/lib/app/questionnaire/scoring/types';
import type {
  CohortScoring,
  CohortScaleSummary,
  CohortScaleBySegment,
} from '@/lib/app/questionnaire/cohort-report/types';
import {
  narrowToEnum,
  PROFILE_FIELD_TYPES,
  ANSWER_PROVENANCES,
  type AnswerProvenance,
  type ProfileFieldConfig,
} from '@/lib/app/questionnaire/types';
import type { ProvenanceBreakdown } from '@/lib/app/questionnaire/analytics/views';
import { isRecord } from '@/lib/utils';
import type {
  CohortDataset,
  CohortSegment,
  CohortSegmentation,
  SegmentDimension,
  CohortDataSlots,
  CohortDataSlotSummary,
  CohortDataSlotByDimension,
} from '@/lib/app/questionnaire/cohort-report/types';
import { SUBGROUP_DIMENSION_KEY } from '@/lib/app/questionnaire/cohort-report/types';
import {
  scopeRoundId,
  scopeSessionWhere,
  type ReportScope,
} from '@/lib/app/questionnaire/cohort-report/scope';

/** Max equal-width buckets for a numeric segmentation dimension (e.g. age groups). */
const MAX_NUMERIC_SEGMENTS = 6;

/** Parameters for {@link buildCohortDataset}: the report scope (a round, or version-wide). */
export type BuildCohortDatasetParams = ReportScope;

/** A session enriched with the columns segmentation needs (profile values + subgroup). */
interface SegmentableSession extends SessionForDistribution {
  subgroupId: string | null;
  profile: Record<string, unknown>;
}

/** A dimension and its session buckets — the shared substrate for both segmentation + scoring. */
interface DimensionGrouping {
  dimension: SegmentDimension;
  buckets: Array<{ value: string; label: string; sessions: SegmentableSession[] }>;
}

/** Mean of a finite-number list, or null when empty. */
function meanOf(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** A zeroed provenance breakdown. */
function emptyProvenance(): ProvenanceBreakdown {
  return { direct: 0, inferred: 0, synthesised: 0, refined: 0 };
}

/**
 * Aggregate the data slots — the semantic substance of the responses (F14.7) — across the cohort:
 * per-slot fill rate / confidence / provenance overall, and fill rate per segment. Counts only
 * (k-anonymity-safe); the raw paraphrases that feed the narrative agent are loaded separately,
 * server-side. Returns undefined when the version has no data slots or no fills at all.
 */
async function buildDataSlots(
  versionId: string,
  sessions: SegmentableSession[],
  groupings: DimensionGrouping[],
  totalSessions: number
): Promise<CohortDataSlots | undefined> {
  const slots = await prisma.appDataSlot.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, key: true, name: true, theme: true },
  });
  if (slots.length === 0) return undefined;

  const sessionIds = sessions.map((s) => s.id);
  const fills =
    sessionIds.length > 0
      ? await prisma.appDataSlotFill.findMany({
          where: { sessionId: { in: sessionIds } },
          select: { sessionId: true, dataSlotId: true, confidence: true, provenanceLabel: true },
        })
      : [];
  if (fills.length === 0) return undefined;

  // Per-slot: the set of sessions that filled it, confidences, provenance tally.
  const bySlot = new Map<
    string,
    { sessions: Set<string>; confidences: number[]; provenance: ProvenanceBreakdown }
  >();
  for (const slot of slots) {
    bySlot.set(slot.id, { sessions: new Set(), confidences: [], provenance: emptyProvenance() });
  }
  for (const f of fills) {
    const bucket = bySlot.get(f.dataSlotId);
    if (!bucket) continue;
    bucket.sessions.add(f.sessionId);
    if (typeof f.confidence === 'number') bucket.confidences.push(f.confidence);
    bucket.provenance[
      narrowToEnum<AnswerProvenance>(f.provenanceLabel, ANSWER_PROVENANCES, 'direct')
    ] += 1;
  }

  const overallSuppressed = isCohortSuppressed(totalSessions);
  const overall: CohortDataSlotSummary[] = slots.map((slot) => {
    const b = bySlot.get(slot.id)!;
    const filled = b.sessions.size;
    return {
      key: slot.key,
      name: slot.name,
      theme: slot.theme,
      filled: overallSuppressed ? 0 : filled,
      responseRate: overallSuppressed || totalSessions === 0 ? 0 : filled / totalSessions,
      avgConfidence: overallSuppressed ? null : meanOf(b.confidences),
      provenance: overallSuppressed ? emptyProvenance() : b.provenance,
      suppressed: overallSuppressed,
    };
  });

  const byDimension: CohortDataSlotByDimension[] = groupings.map((g) => ({
    dimensionKey: g.dimension.key,
    dimensionLabel: g.dimension.label,
    slots: slots.map((slot) => {
      const filledSet = bySlot.get(slot.id)!.sessions;
      return {
        key: slot.key,
        name: slot.name,
        segments: g.buckets.map((bucket) => {
          const segTotal = bucket.sessions.length;
          const suppressed = isCohortSuppressed(segTotal);
          return {
            value: bucket.value,
            label: bucket.label,
            filled: suppressed ? 0 : bucket.sessions.filter((s) => filledSet.has(s.id)).length,
            totalSessions: segTotal,
            suppressed,
          };
        }),
      };
    }),
  }));

  return { overall, byDimension };
}

/**
 * Aggregate deterministic scores across the cohort (F14.4): per-scale overall summaries (mean + band
 * distribution) and per-dimension per-scale segment means. Returns undefined when no schema is
 * authored or it has no items. k-anonymity: a scale/segment below the floor reports `mean: null` and
 * no band counts (`suppressed: true`).
 */
async function buildScoring(
  versionId: string,
  sessions: SegmentableSession[],
  groupings: DimensionGrouping[]
): Promise<CohortScoring | undefined> {
  const schemaRow = await prisma.appScoringSchema.findUnique({
    where: { versionId },
    select: { content: true },
  });
  if (!schemaRow) return undefined;
  const schema = narrowScoringSchemaContent(schemaRow.content);
  if (schema.items.length === 0 || schema.scales.length === 0) return undefined;

  const inputs = await buildScoringInputs(versionId);
  const scoresBySession = await scoreSessions(
    schema,
    sessions.map((s) => s.id),
    inputs
  );

  /** Collect raw scores + band labels for a scale across a set of sessions. */
  const collect = (scaleKey: string, sessionIds: string[]) => {
    const raws: number[] = [];
    const bands: (string | null)[] = [];
    for (const id of sessionIds) {
      const score: RespondentScores | undefined = scoresBySession.get(id);
      const scale = score?.[scaleKey];
      if (!scale) continue;
      raws.push(scale.raw);
      bands.push(scale.band);
    }
    return { raws, bands };
  };

  const allIds = sessions.map((s) => s.id);
  const scales: CohortScaleSummary[] = schema.scales.map((scale) => {
    const { raws, bands } = collect(scale.key, allIds);
    const suppressed = isCohortSuppressed(raws.length);
    const bandCounts: { label: string; count: number }[] = [];
    if (!suppressed) {
      const counts = new Map<string, number>();
      for (const b of bands) {
        if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      for (const [label, count] of counts) bandCounts.push({ label, count });
    }
    return {
      scaleKey: scale.key,
      scaleName: scale.name,
      respondents: raws.length,
      mean: suppressed ? null : meanOf(raws),
      bandCounts,
      suppressed,
    };
  });

  const byDimension = groupings.map((g) => ({
    dimensionKey: g.dimension.key,
    dimensionLabel: g.dimension.label,
    scales: schema.scales.map((scale): CohortScaleBySegment => ({
      scaleKey: scale.key,
      scaleName: scale.name,
      segments: g.buckets.map((b) => {
        const { raws } = collect(
          scale.key,
          b.sessions.map((s) => s.id)
        );
        const suppressed = isCohortSuppressed(raws.length);
        return {
          value: b.value,
          label: b.label,
          respondents: raws.length,
          mean: suppressed ? null : meanOf(raws),
          suppressed,
        };
      }),
    })),
  }));

  return { scales, byDimension };
}

/** Coerce a stored profile value to a finite number, or null. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Profile fields eligible as segmentation dimensions: discrete (`select`) or numeric (`number`). */
function eligibleProfileDimensions(profileFields: ProfileFieldConfig[]): ProfileFieldConfig[] {
  return profileFields.filter((f) => {
    const type = narrowToEnum(f.type, PROFILE_FIELD_TYPES, 'text');
    return type === 'select' || type === 'number';
  });
}

/** Build the ordered numeric buckets and a value→bucket-label mapper for a numeric dimension. */
function numericBuckets(values: number[]): {
  labels: string[];
  bucketOf: (value: number) => string;
} {
  if (values.length === 0) return { labels: [], bucketOf: () => '' };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const label = `${min}`;
    return { labels: [label], bucketOf: () => label };
  }
  const distinct = new Set(values).size;
  const binCount = Math.min(MAX_NUMERIC_SEGMENTS, Math.max(1, distinct));
  const width = (max - min) / binCount;
  const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
  const labels = Array.from({ length: binCount }, (_, i) => {
    const lo = min + i * width;
    const hi = i === binCount - 1 ? max : min + (i + 1) * width;
    return `${fmt(lo)}–${fmt(hi)}`;
  });
  const bucketOf = (value: number): string => {
    const idx =
      value === max ? binCount - 1 : Math.min(binCount - 1, Math.floor((value - min) / width));
    return labels[idx];
  };
  return { labels, bucketOf };
}

/** Assemble one segment from a session subset + the pre-grouped answers. */
function buildSegment(
  value: string,
  label: string,
  slots: SlotForDistribution[],
  sessions: SegmentableSession[],
  answersBySession: Map<string, AnswerForDistribution[]>
): CohortSegment {
  const answers = sessions.flatMap((s) => answersBySession.get(s.id) ?? []);
  const assembled = assembleQuestionDistributions(slots, sessions, answers);
  return {
    value,
    label,
    totalSessions: assembled.totalSessions,
    completedSessions: assembled.completedSessions,
    suppressed: assembled.suppressed,
    questions: assembled.questions,
  };
}

/**
 * Build the {@link CohortDataset} for a round + version. Three queries (slots, sessions+profile,
 * answers); everything else is in-memory grouping. K-anonymity is applied per segment by the shared
 * {@link assembleQuestionDistributions}.
 */
export async function buildCohortDataset(scope: BuildCohortDatasetParams): Promise<CohortDataset> {
  const versionId = scope.versionId;

  // 1. The version's questions, in display order (same projection the F8.1 distributions use).
  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    select: DISTRIBUTION_SLOT_SELECT,
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
  });

  // The version's profile schema + anonymous mode + cohort-report config (lazy; absent = defaults).
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { profileFields: true, anonymousMode: true, cohortReport: true },
  });
  const anonymous = config?.anonymousMode ?? false;
  const scoringEnabled = narrowCohortReportSettings(config?.cohortReport).generation.scoringEnabled;
  const profileFields: ProfileFieldConfig[] =
    !anonymous && Array.isArray(config?.profileFields)
      ? (config.profileFields as unknown as ProfileFieldConfig[])
      : [];

  // 2. The in-scope non-preview sessions for this version, with profile snapshot + subgroup.
  const sessionRows = await prisma.appQuestionnaireSession.findMany({
    where: scopeSessionWhere(scope),
    select: {
      id: true,
      status: true,
      cohortSubgroupId: true,
      profileSnapshot: { select: { values: true } },
    },
  });
  const sessions: SegmentableSession[] = sessionRows.map((s) => ({
    id: s.id,
    status: s.status,
    subgroupId: s.cohortSubgroupId,
    profile: isRecord(s.profileSnapshot?.values) ? s.profileSnapshot.values : {},
  }));
  const sessionIds = sessions.map((s) => s.id);

  // 3. The answers for those sessions + those questions, in one query; grouped by session.
  const questionIds = slots.map((s) => s.id);
  const answerRows =
    sessionIds.length > 0 && questionIds.length > 0
      ? await prisma.appAnswerSlot.findMany({
          where: { sessionId: { in: sessionIds }, questionSlotId: { in: questionIds } },
          select: {
            sessionId: true,
            questionSlotId: true,
            value: true,
            confidence: true,
            provenanceLabel: true,
          },
        })
      : [];
  const answersBySession = new Map<string, AnswerForDistribution[]>();
  for (const a of answerRows) {
    const list = answersBySession.get(a.sessionId) ?? [];
    list.push({
      questionSlotId: a.questionSlotId,
      value: a.value,
      confidence: a.confidence,
      provenanceLabel: a.provenanceLabel,
    });
    answersBySession.set(a.sessionId, list);
  }

  // Overall distributions (un-segmented).
  const overallAnswers = sessions.flatMap((s) => answersBySession.get(s.id) ?? []);
  const overall = assembleQuestionDistributions(slots, sessions, overallAnswers);

  // Build the dimension groupings (dimension → buckets of sessions) once; both the per-question
  // segmentation and the scored aggregation (F14.4) derive from them. Skipped in anonymous mode.
  const groupings: DimensionGrouping[] = [];
  if (!anonymous) {
    // Profile-field dimensions (select buckets by option; number buckets by range).
    for (const field of eligibleProfileDimensions(profileFields)) {
      const type = narrowToEnum(field.type, PROFILE_FIELD_TYPES, 'text');
      const dimension: SegmentDimension = {
        key: field.key,
        label: field.label,
        source: 'profile',
        kind: type === 'number' ? 'number' : 'select',
      };
      const buckets = new Map<string, SegmentableSession[]>();
      if (type === 'number') {
        const numeric = sessions
          .map((s) => asFiniteNumber(s.profile[field.key]))
          .filter((n): n is number => n !== null);
        const { labels, bucketOf } = numericBuckets(numeric);
        for (const label of labels) buckets.set(label, []);
        for (const s of sessions) {
          const n = asFiniteNumber(s.profile[field.key]);
          if (n === null) continue;
          buckets.get(bucketOf(n))!.push(s);
        }
      } else {
        const options = Array.isArray(field.options) ? field.options : [];
        for (const opt of options) buckets.set(opt, []);
        for (const s of sessions) {
          const raw = s.profile[field.key];
          // A select value is stored as the chosen string (or a number); anything else can't match
          // an option, so it's skipped rather than coerced via `[object Object]`.
          const val = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
          if (val === '' || !buckets.has(val)) continue;
          buckets.get(val)!.push(s);
        }
      }
      const bucketList = [...buckets.entries()]
        .filter(([, segSessions]) => segSessions.length > 0)
        .map(([value, segSessions]) => ({ value, label: value, sessions: segSessions }));
      if (bucketList.length > 0) groupings.push({ dimension, buckets: bucketList });
    }

    // Subgroup dimension — present only when at least one session carries a subgroup.
    const subgroupIds = [
      ...new Set(sessions.map((s) => s.subgroupId).filter((id): id is string => !!id)),
    ];
    if (subgroupIds.length > 0) {
      const subgroups = await prisma.appCohortSubgroup.findMany({
        where: { id: { in: subgroupIds } },
        select: { id: true, name: true },
      });
      const nameById = new Map(subgroups.map((g) => [g.id, g.name]));
      groupings.push({
        dimension: {
          key: SUBGROUP_DIMENSION_KEY,
          label: 'Subgroup',
          source: 'subgroup',
          kind: 'subgroup',
        },
        buckets: subgroupIds.map((id) => ({
          value: id,
          label: nameById.get(id) ?? id,
          sessions: sessions.filter((s) => s.subgroupId === id),
        })),
      });
    }
  }

  const segmentation: CohortSegmentation[] = groupings.map((g) => ({
    dimension: g.dimension,
    segments: g.buckets.map((b) =>
      buildSegment(b.value, b.label, slots, b.sessions, answersBySession)
    ),
  }));

  // Data-slot aggregation (F14.7) — the semantic substance; present when the version has fills.
  const dataSlots = await buildDataSlots(versionId, sessions, groupings, overall.totalSessions);

  // Scored aggregation (F14.4) — present only when scoring is enabled + a schema exists.
  const scoring = scoringEnabled ? await buildScoring(versionId, sessions, groupings) : undefined;

  return {
    roundId: scopeRoundId(scope),
    roundName: scope.label,
    versionId,
    totalSessions: overall.totalSessions,
    completedSessions: overall.completedSessions,
    kThreshold: K_ANONYMITY_THRESHOLD,
    suppressed: overall.suppressed,
    anonymous,
    overall: overall.questions,
    segmentation,
    dataSlots,
    scoring,
  };
}

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
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import {
  narrowToEnum,
  PROFILE_FIELD_TYPES,
  type ProfileFieldConfig,
} from '@/lib/app/questionnaire/types';
import { isRecord } from '@/lib/utils';
import type {
  CohortDataset,
  CohortSegment,
  CohortSegmentation,
  SegmentDimension,
} from '@/lib/app/questionnaire/cohort-report/types';
import { SUBGROUP_DIMENSION_KEY } from '@/lib/app/questionnaire/cohort-report/types';

/** Max equal-width buckets for a numeric segmentation dimension (e.g. age groups). */
const MAX_NUMERIC_SEGMENTS = 6;

/** Parameters for {@link buildCohortDataset}: a round + the version whose sessions to analyse. */
export interface BuildCohortDatasetParams {
  roundId: string;
  roundName: string;
  versionId: string;
}

/** A session enriched with the columns segmentation needs (profile values + subgroup). */
interface SegmentableSession extends SessionForDistribution {
  subgroupId: string | null;
  profile: Record<string, unknown>;
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
export async function buildCohortDataset(params: BuildCohortDatasetParams): Promise<CohortDataset> {
  const { roundId, roundName, versionId } = params;

  // 1. The version's questions, in display order (same projection the F8.1 distributions use).
  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    select: DISTRIBUTION_SLOT_SELECT,
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
  });

  // The version's profile schema + anonymous mode (config is 1:1 and lazy — absent = no profile).
  const config = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId },
    select: { profileFields: true, anonymousMode: true },
  });
  const anonymous = config?.anonymousMode ?? false;
  const profileFields: ProfileFieldConfig[] =
    !anonymous && Array.isArray(config?.profileFields)
      ? (config.profileFields as unknown as ProfileFieldConfig[])
      : [];

  // 2. The round's non-preview sessions for this version, with profile snapshot + subgroup.
  const sessionRows = await prisma.appQuestionnaireSession.findMany({
    where: { versionId, roundId, isPreview: false },
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

  // Segmentation — skipped entirely in anonymous mode (no profile axis to split on).
  const segmentation: CohortSegmentation[] = [];
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
      const segments = [...buckets.entries()]
        .filter(([, segSessions]) => segSessions.length > 0)
        .map(([value, segSessions]) =>
          buildSegment(value, value, slots, segSessions, answersBySession)
        );
      if (segments.length > 0) segmentation.push({ dimension, segments });
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
      const segments: CohortSegment[] = subgroupIds.map((id) => {
        const segSessions = sessions.filter((s) => s.subgroupId === id);
        return buildSegment(id, nameById.get(id) ?? id, slots, segSessions, answersBySession);
      });
      segmentation.push({
        dimension: {
          key: SUBGROUP_DIMENSION_KEY,
          label: 'Subgroup',
          source: 'subgroup',
          kind: 'subgroup',
        },
        segments,
      });
    }
  }

  return {
    roundId,
    roundName,
    versionId,
    totalSessions: overall.totalSessions,
    completedSessions: overall.completedSessions,
    kThreshold: K_ANONYMITY_THRESHOLD,
    suppressed: overall.suppressed,
    anonymous,
    overall: overall.questions,
    segmentation,
  };
}

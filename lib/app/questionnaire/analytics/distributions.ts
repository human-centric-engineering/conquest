/**
 * Per-question answer distributions (F8.1).
 *
 * For each question in a version (optionally filtered to a tag set), aggregate the
 * answers captured across the **non-preview** sessions in the date window into a
 * type-appropriate distribution: choice/likert option counts, a numeric summary +
 * histogram, boolean true/false, date buckets. `free_text` deliberately carries no
 * value detail — only response rate, confidence, and provenance — so respondent
 * prose never crosses this boundary (PII-safe ahead of F8.3).
 *
 * Three queries, no N+1: the version's slots (+ section + tags), the sessions in
 * scope (the response-rate denominator), and the answer rows for those sessions.
 * Everything else is in-memory grouping.
 */

import { prisma } from '@/lib/db/client';
import {
  ANSWER_PROVENANCES,
  QUESTION_TYPE_LABELS,
  narrowToEnum,
  TAG_COLORS,
  type AnswerProvenance,
  type QuestionType,
  QUESTION_TYPES,
} from '@/lib/app/questionnaire/types';
import { typeConfigSchemaFor } from '@/lib/app/questionnaire/authoring/type-config-schema';
import { isAnalyticsPanelSuppressed } from '@/lib/app/questionnaire/analytics/privacy';
import type { TagColor } from '@/lib/app/questionnaire/types';
import type { TagView } from '@/lib/app/questionnaire/views';
import {
  roundSessionFilter,
  type AnalyticsScope,
} from '@/lib/app/questionnaire/analytics/query-schema';
import type {
  DistributionDetail,
  HistogramBin,
  ProvenanceBreakdown,
  QuestionDistribution,
  QuestionDistributionsResult,
  ValueBucket,
} from '@/lib/app/questionnaire/analytics/views';

/** Max histogram bins for a numeric question (Sturges-ish, capped for a tidy chart). */
const MAX_NUMERIC_BINS = 8;

/** A zeroed provenance breakdown — one counter per label in the vocabulary. */
function emptyProvenance(): ProvenanceBreakdown {
  const acc: ProvenanceBreakdown = { direct: 0, inferred: 0, synthesised: 0, refined: 0 };
  return acc;
}

/** Read a choice question's `[{ value, label }]` options from its stored config. */
function readChoices(
  type: QuestionType,
  typeConfig: unknown
): Array<{ value: string; label: string }> {
  const parsed = typeConfigSchemaFor(type).safeParse(typeConfig);
  if (!parsed.success) return [];
  const cfg = parsed.data as { choices?: Array<{ value: string; label: string }> };
  return Array.isArray(cfg.choices) ? cfg.choices : [];
}

function readLikert(typeConfig: unknown): {
  min: number;
  max: number;
  minLabel?: string;
  maxLabel?: string;
  labels?: string[];
} | null {
  const parsed = typeConfigSchemaFor('likert').safeParse(typeConfig);
  if (!parsed.success) return null;
  return parsed.data as {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
    labels?: string[];
  };
}

function readMatrix(typeConfig: unknown): {
  rows: Array<{ key: string; label: string }>;
  scale: { min: number; max: number; minLabel?: string; maxLabel?: string; labels?: string[] };
} | null {
  const parsed = typeConfigSchemaFor('matrix').safeParse(typeConfig);
  if (!parsed.success) return null;
  return parsed.data as {
    rows: Array<{ key: string; label: string }>;
    scale: { min: number; max: number; minLabel?: string; maxLabel?: string; labels?: string[] };
  };
}

function readBooleanLabels(typeConfig: unknown): { trueLabel: string; falseLabel: string } {
  const parsed = typeConfigSchemaFor('boolean').safeParse(typeConfig ?? {});
  const cfg = parsed.success ? (parsed.data as { trueLabel?: string; falseLabel?: string }) : {};
  return { trueLabel: cfg.trueLabel ?? 'True', falseLabel: cfg.falseLabel ?? 'False' };
}

/** Coerce a stored answer value to a finite number, or null. Mirrors extraction's strictness. */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Build a numeric histogram with up to {@link MAX_NUMERIC_BINS} equal-width bins. */
function buildHistogram(values: number[]): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return [{ label: `${min}`, min, max, count: values.length }];
  }
  const binCount = Math.min(MAX_NUMERIC_BINS, Math.max(1, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => {
    const lo = min + i * width;
    const hi = i === binCount - 1 ? max : min + (i + 1) * width;
    return {
      label: `${formatBound(lo)}–${formatBound(hi)}`,
      min: lo,
      max: hi,
      count: 0,
    };
  });
  for (const v of values) {
    // Top bin is inclusive of `max`; others are half-open [lo, hi).
    const idx = v === max ? binCount - 1 : Math.min(binCount - 1, Math.floor((v - min) / width));
    bins[idx].count += 1;
  }
  return bins;
}

function formatBound(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

/** Compute the type-appropriate {@link DistributionDetail} from a question's answers. */
function buildDetail(
  type: QuestionType,
  typeConfig: unknown,
  values: unknown[]
): DistributionDetail {
  switch (type) {
    case 'free_text':
      return { kind: 'free_text' };

    case 'single_choice':
    case 'multi_choice': {
      const choices = readChoices(type, typeConfig);
      const labelByValue = new Map(choices.map((c) => [c.value, c.label]));
      const counts = new Map<string, number>();
      let otherCount = 0;
      for (const raw of values) {
        const picks = type === 'multi_choice' ? (Array.isArray(raw) ? raw : []) : [raw];
        for (const pick of picks) {
          if (typeof pick !== 'string') continue;
          if (labelByValue.has(pick)) {
            counts.set(pick, (counts.get(pick) ?? 0) + 1);
          } else {
            otherCount += 1;
          }
        }
      }
      const buckets: ValueBucket[] = choices.map((c) => ({
        value: c.value,
        label: c.label,
        count: counts.get(c.value) ?? 0,
      }));
      return { kind: 'choice', buckets, otherCount };
    }

    case 'likert': {
      const bounds = readLikert(typeConfig);
      const min = bounds?.min ?? 1;
      const max = bounds?.max ?? 5;
      const counts = new Map<number, number>();
      const nums: number[] = [];
      for (const raw of values) {
        const n = asFiniteNumber(raw);
        if (n === null || !Number.isInteger(n) || n < min || n > max) continue;
        counts.set(n, (counts.get(n) ?? 0) + 1);
        nums.push(n);
      }
      // Prefer a per-point label for every bucket; fall back to legacy endpoint labels,
      // then to the bare number — so each bar reads as a word once the scale is labelled.
      // Require every entry non-empty (matching readLikertConfig) so a blank label never
      // renders as "3 ()".
      const perPoint =
        bounds?.labels &&
        bounds.labels.length === max - min + 1 &&
        bounds.labels.every((l) => l.trim().length > 0)
          ? bounds.labels
          : null;
      const buckets: ValueBucket[] = [];
      for (let v = min; v <= max; v += 1) {
        const word =
          perPoint?.[v - min] ??
          (v === min ? bounds?.minLabel : undefined) ??
          (v === max ? bounds?.maxLabel : undefined);
        const label = word ? `${v} (${word})` : `${v}`;
        buckets.push({ value: `${v}`, label, count: counts.get(v) ?? 0 });
      }
      const mean = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      return { kind: 'likert', min, max, buckets, mean };
    }

    case 'matrix': {
      // A rating grid: each composite answer is a `{ [rowKey]: point }` map. Build one
      // likert-shaped distribution per row, all sharing the grid's scale + point labels.
      const cfg = readMatrix(typeConfig);
      const rows = cfg?.rows ?? [];
      const min = cfg?.scale.min ?? 1;
      const max = cfg?.scale.max ?? 5;
      const s = cfg?.scale;
      const perPoint =
        s?.labels && s.labels.length === max - min + 1 && s.labels.every((l) => l.trim().length > 0)
          ? s.labels
          : null;
      const pointLabel = (v: number): string => {
        const word =
          perPoint?.[v - min] ??
          (v === min ? s?.minLabel : undefined) ??
          (v === max ? s?.maxLabel : undefined);
        return word ? `${v} (${word})` : `${v}`;
      };
      const rowDetails = rows.map((row) => {
        const counts = new Map<number, number>();
        const nums: number[] = [];
        for (const raw of values) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const n = asFiniteNumber((raw as Record<string, unknown>)[row.key]);
          if (n === null || !Number.isInteger(n) || n < min || n > max) continue;
          counts.set(n, (counts.get(n) ?? 0) + 1);
          nums.push(n);
        }
        const buckets: ValueBucket[] = [];
        for (let v = min; v <= max; v += 1) {
          buckets.push({ value: `${v}`, label: pointLabel(v), count: counts.get(v) ?? 0 });
        }
        const mean = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        return { key: row.key, label: row.label, buckets, mean };
      });
      return { kind: 'matrix', min, max, rows: rowDetails };
    }

    case 'numeric': {
      const nums = values.map(asFiniteNumber).filter((n): n is number => n !== null);
      if (nums.length === 0) {
        return { kind: 'numeric', summary: null, histogram: [] };
      }
      const sorted = [...nums].sort((a, b) => a - b);
      const summary = {
        count: nums.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: nums.reduce((a, b) => a + b, 0) / nums.length,
        median: median(sorted),
      };
      return { kind: 'numeric', summary, histogram: buildHistogram(nums) };
    }

    case 'boolean': {
      const { trueLabel, falseLabel } = readBooleanLabels(typeConfig);
      let trueCount = 0;
      let falseCount = 0;
      for (const raw of values) {
        if (raw === true) trueCount += 1;
        else if (raw === false) falseCount += 1;
      }
      return { kind: 'boolean', trueLabel, falseLabel, trueCount, falseCount };
    }

    case 'date': {
      // Bucket by calendar month — coarse enough to read, fine enough to spot spread.
      const counts = new Map<string, number>();
      for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const month = raw.slice(0, 7); // YYYY-MM from an ISO date/datetime
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        counts.set(month, (counts.get(month) ?? 0) + 1);
      }
      const buckets = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, count]) => ({ label, count }));
      return { kind: 'date', buckets };
    }
  }
}

/** A question slot projected for distribution assembly (the columns the aggregator reads). */
export interface SlotForDistribution {
  id: string;
  key: string;
  prompt: string;
  type: string;
  typeConfig: unknown;
  required: boolean;
  section: { title: string; ordinal: number };
  tags: { tag: { id: string; label: string; color: string | null } }[];
}

/** A session projected for distribution assembly — the denominator + completion split. */
export interface SessionForDistribution {
  id: string;
  status: string;
}

/** An answer row projected for distribution assembly. */
export interface AnswerForDistribution {
  questionSlotId: string;
  value: unknown;
  confidence: number | null;
  provenanceLabel: string;
}

/** The denominator/detail portion of a distributions result (everything but versionId + range). */
export interface AssembledDistributions {
  totalSessions: number;
  completedSessions: number;
  suppressed: boolean;
  questions: QuestionDistribution[];
}

/**
 * Pure in-memory assembly of per-question distributions from already-fetched slots, sessions and
 * answers. Shared by {@link getQuestionDistributions} (version/round scope) and the F14.1 cohort
 * dataset (which calls it once for the whole round and again per demographic segment, over a session
 * subset — so segmentation reuses the exact same k-anonymity + detail logic). No I/O.
 */
export function assembleQuestionDistributions(
  slots: SlotForDistribution[],
  sessions: SessionForDistribution[],
  answers: AnswerForDistribution[]
): AssembledDistributions {
  const totalSessions = sessions.length;
  const completedSessions = sessions.filter((s) => s.status === 'completed').length;

  // Group answers by question.
  const byQuestion = new Map<
    string,
    { values: unknown[]; confidences: number[]; provenance: ProvenanceBreakdown }
  >();
  for (const slot of slots) {
    byQuestion.set(slot.id, { values: [], confidences: [], provenance: emptyProvenance() });
  }
  for (const a of answers) {
    const bucket = byQuestion.get(a.questionSlotId);
    if (!bucket) continue;
    bucket.values.push(a.value);
    if (typeof a.confidence === 'number') bucket.confidences.push(a.confidence);
    const label = narrowToEnum<AnswerProvenance>(a.provenanceLabel, ANSWER_PROVENANCES, 'direct');
    bucket.provenance[label] += 1;
  }

  // F8.3: below the k-anonymity threshold a per-question distribution over a handful of
  // sessions can re-identify a respondent's exact answer, so withhold all per-question
  // detail and zero the counts. The question structure (prompt/type/section/tags) stays —
  // only the response data is suppressed. An empty cohort (0) is not "suppressed".
  const suppressed = isAnalyticsPanelSuppressed(totalSessions);

  const questions: QuestionDistribution[] = slots.map((slot) => {
    const type = narrowToEnum<QuestionType>(slot.type, QUESTION_TYPES, 'free_text');
    const bucket = byQuestion.get(slot.id)!;
    const tags: TagView[] = slot.tags.map((t) => ({
      id: t.tag.id,
      label: t.tag.label,
      // `color` is a free String? column constrained to the allowlist at write time;
      // validate membership before narrowing rather than blindly casting the DB value.
      color:
        t.tag.color !== null && (TAG_COLORS as readonly string[]).includes(t.tag.color)
          ? (t.tag.color as TagColor)
          : null,
    }));
    const base = {
      questionId: slot.id,
      key: slot.key,
      prompt: slot.prompt,
      type,
      sectionTitle: slot.section.title,
      required: slot.required,
      tags,
    };
    if (suppressed) {
      return {
        ...base,
        answeredCount: 0,
        unansweredCount: 0,
        responseRate: 0,
        avgConfidence: null,
        provenance: emptyProvenance(),
        detail: { kind: 'suppressed' },
      };
    }
    const answeredCount = bucket.values.length;
    const avgConfidence =
      bucket.confidences.length > 0
        ? bucket.confidences.reduce((a, b) => a + b, 0) / bucket.confidences.length
        : null;
    return {
      ...base,
      answeredCount,
      unansweredCount: Math.max(0, totalSessions - answeredCount),
      responseRate: totalSessions > 0 ? answeredCount / totalSessions : 0,
      avgConfidence,
      provenance: bucket.provenance,
      detail: buildDetail(type, slot.typeConfig, bucket.values),
    };
  });

  return { totalSessions, completedSessions, suppressed, questions };
}

/** The standard slot projection for distribution assembly (the {@link SlotForDistribution} select). */
export const DISTRIBUTION_SLOT_SELECT = {
  id: true,
  key: true,
  prompt: true,
  type: true,
  typeConfig: true,
  required: true,
  ordinal: true,
  section: { select: { title: true, ordinal: true } },
  tags: { select: { tag: { select: { id: true, label: true, color: true } } } },
} as const;

/**
 * Aggregate per-question answer distributions for a version over the non-preview
 * sessions in scope. Tag-filtered when `scope.tagIds` is non-empty.
 */
export async function getQuestionDistributions(
  scope: AnalyticsScope
): Promise<QuestionDistributionsResult> {
  const range = { from: scope.from.toISOString(), to: scope.to.toISOString() };

  // 1. The version's questions (optionally restricted to the tag filter), with
  //    section + tag projections, in display order.
  const slots = await prisma.appQuestionSlot.findMany({
    where: {
      versionId: scope.versionId,
      ...(scope.tagIds.length > 0 ? { tags: { some: { tagId: { in: scope.tagIds } } } } : {}),
    },
    select: DISTRIBUTION_SLOT_SELECT,
    orderBy: [{ section: { ordinal: 'asc' } }, { ordinal: 'asc' }],
  });

  // 2. The non-preview sessions in the window — the response-rate denominator.
  const sessions = await prisma.appQuestionnaireSession.findMany({
    where: {
      versionId: scope.versionId,
      isPreview: false,
      createdAt: { gte: scope.from, lt: scope.to },
      ...roundSessionFilter(scope.roundId),
    },
    select: { id: true, status: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  // 3. The answers for those sessions + those questions, in one query.
  const questionIds = slots.map((s) => s.id);
  const answers =
    sessionIds.length > 0 && questionIds.length > 0
      ? await prisma.appAnswerSlot.findMany({
          where: { sessionId: { in: sessionIds }, questionSlotId: { in: questionIds } },
          select: { questionSlotId: true, value: true, confidence: true, provenanceLabel: true },
        })
      : [];

  const assembled = assembleQuestionDistributions(slots, sessions, answers);

  return {
    versionId: scope.versionId,
    range,
    ...assembled,
  };
}

/** Re-exported for the read view / tests that label types. */
export { QUESTION_TYPE_LABELS };

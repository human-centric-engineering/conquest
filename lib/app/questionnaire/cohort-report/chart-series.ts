/**
 * Cohort Report — chart series builder (report kind `cohort`, F14.2).
 *
 * `buildChartData(spec, dataset)` resolves a declarative {@link ChartSpec} against a
 * {@link CohortDataset} into the uniform {@link ChartData} the web (recharts) and PDF (react-pdf)
 * renderers both consume. Pure, no I/O — so the same series powers both surfaces and is unit-tested
 * directly. Respects k-anonymity: a suppressed question/segment contributes no answer-derived value
 * (the chart shows a placeholder or simply omits that segment) rather than a misleading zero.
 */

import type { QuestionDistribution } from '@/lib/app/questionnaire/analytics/views';
import type {
  CohortDataset,
  CohortSegment,
  CohortSegmentation,
} from '@/lib/app/questionnaire/cohort-report/types';
import type {
  ChartData,
  ChartDatum,
  ChartSpec,
  CohortChartDisplay,
} from '@/lib/app/questionnaire/cohort-report/chart-types';

const COUNT_SERIES = [{ key: 'count', label: 'Respondents' }];

/** Find a question's distribution within a list (overall or a segment's). */
function findQuestion(
  questions: QuestionDistribution[],
  questionId: string | undefined
): QuestionDistribution | undefined {
  return questionId ? questions.find((q) => q.questionId === questionId) : undefined;
}

/** Find a segmentation dimension by key. */
function findDimension(
  dataset: CohortDataset,
  dimensionKey: string | undefined
): CohortSegmentation | undefined {
  return dimensionKey
    ? dataset.segmentation.find((s) => s.dimension.key === dimensionKey)
    : undefined;
}

/** The mean of a likert/numeric question's distribution, or null when not applicable / suppressed. */
function questionMean(q: QuestionDistribution | undefined): number | null {
  if (!q) return null;
  if (q.detail.kind === 'likert') return q.detail.mean;
  if (q.detail.kind === 'numeric') return q.detail.summary?.mean ?? null;
  return null;
}

/** A well-formed-but-no-data result (unknown question/dimension, or unsupported question type). */
function emptyResult(spec: ChartSpec, display: CohortChartDisplay, valueLabel: string): ChartData {
  return {
    spec,
    display,
    series: COUNT_SERIES,
    data: [],
    valueLabel,
    isPercent: false,
    suppressed: false,
    empty: true,
  };
}

/** Build the answer-bucket data for one question's distribution (the `question_distribution` kind). */
function buildDistribution(spec: ChartSpec, q: QuestionDistribution | undefined): ChartData {
  const base = { spec, display: 'bar' as const, series: COUNT_SERIES, valueLabel: 'Respondents' };
  if (!q) return emptyResult(spec, 'bar', 'Respondents');
  const d = q.detail;
  if (d.kind === 'suppressed') {
    return { ...base, data: [], isPercent: false, suppressed: true, empty: false };
  }
  let data: ChartDatum[];
  switch (d.kind) {
    case 'choice':
    case 'likert':
      data = d.buckets.map((b) => ({ category: b.label, values: { count: b.count } }));
      break;
    case 'boolean':
      data = [
        { category: d.trueLabel, values: { count: d.trueCount } },
        { category: d.falseLabel, values: { count: d.falseCount } },
      ];
      break;
    case 'numeric':
      data = d.histogram.map((b) => ({ category: b.label, values: { count: b.count } }));
      break;
    case 'date':
      data = d.buckets.map((b) => ({ category: b.label, values: { count: b.count } }));
      break;
    default: // free_text — no distribution to plot
      return emptyResult(spec, 'bar', 'Respondents');
  }
  return { ...base, data, isPercent: false, suppressed: false, empty: data.length === 0 };
}

/**
 * Build a one-value-per-segment bar for a dimension. `valueOf` returns the segment's value, or null
 * to omit it (suppressed / not applicable). `isPercent`/`valueLabel` describe the y-axis.
 */
function buildBySegment(
  spec: ChartSpec,
  dimension: CohortSegmentation | undefined,
  valueLabel: string,
  isPercent: boolean,
  valueOf: (segment: CohortSegment) => number | null
): ChartData {
  if (!dimension) return emptyResult(spec, 'bar', valueLabel);
  const data: ChartDatum[] = [];
  for (const seg of dimension.segments) {
    const value = valueOf(seg);
    if (value === null) continue;
    data.push({ category: seg.label, values: { count: value } });
  }
  return {
    spec,
    display: spec.display ?? 'bar',
    series: COUNT_SERIES,
    data,
    valueLabel,
    isPercent,
    suppressed: false,
    empty: data.length === 0,
  };
}

/**
 * Resolve a {@link ChartSpec} against a {@link CohortDataset} into renderable {@link ChartData}.
 * Never throws on a malformed/unresolvable spec — returns `empty: true` instead, so a stale chart
 * reference (e.g. a question removed by a later edit) degrades gracefully.
 */
export function buildChartData(spec: ChartSpec, dataset: CohortDataset): ChartData {
  switch (spec.kind) {
    case 'question_distribution':
      return buildDistribution(spec, findQuestion(dataset.overall, spec.questionId));

    case 'question_mean_by_segment':
      return buildBySegment(
        spec,
        findDimension(dataset, spec.dimensionKey),
        'Mean',
        false,
        (seg) =>
          seg.suppressed ? null : questionMean(findQuestion(seg.questions, spec.questionId))
      );

    case 'response_rate_by_segment':
      return buildBySegment(
        spec,
        findDimension(dataset, spec.dimensionKey),
        '% responded',
        true,
        (seg) => {
          if (seg.suppressed) return null;
          const q = findQuestion(seg.questions, spec.questionId);
          return q ? q.responseRate : null;
        }
      );

    case 'completion_by_segment':
      return buildBySegment(
        spec,
        findDimension(dataset, spec.dimensionKey),
        '% completed',
        true,
        (seg) => (seg.totalSessions > 0 ? seg.completedSessions / seg.totalSessions : 0)
      );

    case 'segment_sizes':
      return buildBySegment(
        spec,
        findDimension(dataset, spec.dimensionKey),
        'Respondents',
        false,
        (seg) => seg.totalSessions
      );
  }
}

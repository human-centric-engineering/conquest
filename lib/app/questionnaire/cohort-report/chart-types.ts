/**
 * Cohort Report — chart contract (report kind `cohort`, F14.2).
 *
 * A declarative {@link ChartSpec} (what to plot) and the uniform {@link ChartData} (the computed,
 * plottable series) it resolves to via `buildChartData`. ONE spec drives BOTH the recharts web
 * chart (F14.2) and the react-pdf chart (F14.6): the web renderer and the PDF renderer consume the
 * same `ChartData`, so a chart looks identical on screen and in the downloaded report. The narrative
 * agent (F14.3) proposes a `ChartSpec[]`; the admin pins/adds/removes (F14.5). Client-safe types
 * (no Prisma, no Next).
 */

/**
 * The kinds of cohort chart. Each maps a slice of the {@link CohortDataset} to a uniform series:
 *  - `question_distribution` — the answer buckets of one question (overall or one segment).
 *  - `question_mean_by_segment` — the mean of a likert/numeric question across a dimension's segments.
 *  - `response_rate_by_segment` — one question's response rate across a dimension's segments.
 *  - `completion_by_segment` — completion rate across a dimension's segments.
 *  - `segment_sizes` — respondent count per segment of a dimension.
 */
export const COHORT_CHART_KINDS = [
  'question_distribution',
  'question_mean_by_segment',
  'response_rate_by_segment',
  'completion_by_segment',
  'segment_sizes',
] as const;
export type CohortChartKind = (typeof COHORT_CHART_KINDS)[number];

/** How to draw the series. `bar` = single series; `grouped`/`stacked` = multi-series bars. */
export const COHORT_CHART_DISPLAYS = ['bar', 'grouped_bar', 'stacked_bar'] as const;
export type CohortChartDisplay = (typeof COHORT_CHART_DISPLAYS)[number];

/** A declarative chart definition over a {@link CohortDataset}. */
export interface ChartSpec {
  /** Stable id (used as a React key + revision-block reference). */
  id: string;
  title: string;
  kind: CohortChartKind;
  /** The question this chart is about — required for the `question_*` kinds. */
  questionId?: string;
  /** The segmentation dimension key — required for `*_by_segment` + `segment_sizes`. */
  dimensionKey?: string;
  /** Rendering hint; defaults per kind. */
  display?: CohortChartDisplay;
}

/** One series in a {@link ChartData} (a bar colour / legend entry). */
export interface ChartSeriesDef {
  key: string;
  label: string;
}

/** One x-axis category with a value per series. */
export interface ChartDatum {
  category: string;
  values: Record<string, number>;
}

/**
 * The computed, plottable result of a {@link ChartSpec} against a dataset — the uniform shape both
 * the recharts web chart and the react-pdf chart render. `suppressed` is true when the underlying
 * data was withheld by k-anonymity (render a placeholder, not an empty chart); `empty` is true when
 * the spec is well-formed but resolved to no data (e.g. unknown question/dimension).
 */
export interface ChartData {
  spec: ChartSpec;
  display: CohortChartDisplay;
  series: ChartSeriesDef[];
  data: ChartDatum[];
  /** Axis label for the value axis (e.g. "Respondents", "Mean", "% responded"). */
  valueLabel: string;
  /** True when the value axis is a 0–1 fraction (percent formatting). */
  isPercent: boolean;
  suppressed: boolean;
  empty: boolean;
}

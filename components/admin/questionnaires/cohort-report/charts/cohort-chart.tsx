'use client';

/**
 * CohortChart — renders a cohort-report {@link ChartData} as a recharts bar chart (F14.2).
 *
 * Presentational: it takes already-computed {@link ChartData} (built by `buildChartData`, shared
 * with the PDF renderer), so the chart looks identical on screen and in the downloaded report. A
 * `suppressed` chart shows the k-anonymity placeholder; an `empty` one shows a no-data note. Single
 * series renders one bar set; `grouped_bar` / `stacked_bar` render one bar per series.
 */

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ChartData } from '@/lib/app/questionnaire/cohort-report/chart-types';

export interface CohortChartProps {
  data: ChartData;
}

/** Distinct bar colours, cycled by series index. */
const SERIES_COLOURS = ['#5469d4', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#60a5fa'];

/** Flatten the uniform `{ category, values }` rows into the flat objects recharts plots. */
function toPlotRows(data: ChartData): Array<Record<string, string | number>> {
  return data.data.map((d) => ({ category: d.category, ...d.values }));
}

function formatValue(value: number, isPercent: boolean): string {
  if (isPercent) return `${Math.round(value * 100)}%`;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

export function CohortChart({ data }: CohortChartProps) {
  const rows = React.useMemo(() => toPlotRows(data), [data]);
  const { spec, series, valueLabel, isPercent, suppressed, empty, display } = data;
  const stacked = display === 'stacked_bar';

  return (
    <Card data-testid="cohort-chart">
      <CardHeader>
        <CardTitle className="text-base">{spec.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {suppressed ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            Hidden to protect respondent privacy — this group is too small to chart.
          </p>
        ) : empty ? (
          <p className="text-muted-foreground py-12 text-center text-sm">
            No data to chart for this selection.
          </p>
        ) : (
          <div className="h-72 w-full" role="img" aria-label={`${spec.title} (${valueLabel})`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="category" tick={{ fontSize: 11 }} interval={0} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatValue(v, isPercent)}
                  domain={isPercent ? [0, 1] : undefined}
                />
                <Tooltip
                  formatter={(value) => [
                    formatValue(typeof value === 'number' ? value : Number(value) || 0, isPercent),
                    valueLabel,
                  ]}
                  contentStyle={{ fontSize: 12 }}
                />
                {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
                {series.map((s, i) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stackId={stacked ? 'stack' : undefined}
                    fill={SERIES_COLOURS[i % SERIES_COLOURS.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

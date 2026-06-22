/**
 * CohortChart component tests (F14.2).
 *
 * recharts renders to SVG under happy-dom; we assert the title + the suppressed/empty placeholders,
 * and that a chart with data renders an SVG (not the placeholder). We do NOT assert chart internals.
 *
 * @see components/admin/questionnaires/cohort-report/charts/cohort-chart.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CohortChart } from '@/components/admin/questionnaires/cohort-report/charts/cohort-chart';
import type { ChartData } from '@/lib/app/questionnaire/cohort-report/chart-types';

function chartData(overrides: Partial<ChartData> = {}): ChartData {
  return {
    spec: { id: 'c1', title: 'Responses by team', kind: 'segment_sizes', dimensionKey: 'team' },
    display: 'bar',
    series: [{ key: 'count', label: 'Respondents' }],
    data: [
      { category: 'Eng', values: { count: 10 } },
      { category: 'Sales', values: { count: 5 } },
    ],
    valueLabel: 'Respondents',
    isPercent: false,
    suppressed: false,
    empty: false,
    ...overrides,
  };
}

describe('CohortChart', () => {
  it('renders the title and the chart region (not a placeholder) when there is data', () => {
    // recharts' ResponsiveContainer reports 0×0 under happy-dom, so we assert the chart region is
    // present and the placeholders are absent rather than querying recharts' SVG internals.
    render(<CohortChart data={chartData()} />);
    expect(screen.getByText('Responses by team')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Responses by team/ })).toBeInTheDocument();
    expect(screen.queryByText(/too small to chart/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no data to chart/i)).not.toBeInTheDocument();
  });

  it('shows the privacy placeholder when suppressed', () => {
    render(<CohortChart data={chartData({ suppressed: true, data: [] })} />);
    expect(screen.getByText(/too small to chart/i)).toBeInTheDocument();
  });

  it('shows the no-data note when empty', () => {
    render(<CohortChart data={chartData({ empty: true, data: [] })} />);
    expect(screen.getByText(/no data to chart/i)).toBeInTheDocument();
  });
});

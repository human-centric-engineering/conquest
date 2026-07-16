/**
 * AnalyticsView — alpha privacy-disclosure note wiring.
 *
 * The analytics dashboard shows a visible note when the temporary alpha k-anonymity bypass is active
 * (`ALPHA_ANALYTICS_ANONYMITY_DISABLED`), and shows nothing when it is off. The three panels + filter
 * are stubbed — this only pins the note's presence/absence against the flag.
 *
 * @see components/admin/questionnaires/analytics/analytics-view.tsx
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/admin/questionnaires/analytics/analytics-filters', () => ({
  AnalyticsFilters: () => <div data-testid="filters" />,
}));
vi.mock('@/components/admin/questionnaires/analytics/question-distribution-panel', () => ({
  QuestionDistributionPanel: () => <div data-testid="distributions" />,
}));
vi.mock('@/components/admin/questionnaires/analytics/completion-funnel-panel', () => ({
  CompletionFunnelPanel: () => <div data-testid="funnel" />,
}));
vi.mock('@/components/admin/questionnaires/analytics/cost-panel', () => ({
  CostPanel: () => <div data-testid="cost" />,
}));

const baseProps = {
  tagVocabulary: [],
  distributions: null,
  funnel: null,
  cost: null,
  filters: { from: '2026-01-01', to: '2026-02-01', tagIds: [] },
  roundOptions: [],
  hasOpenEnded: false,
};

async function loadView(alphaBypass: boolean) {
  vi.resetModules();
  vi.doMock('@/lib/app/questionnaire/analytics/privacy', () => ({
    ALPHA_ANALYTICS_ANONYMITY_DISABLED: alphaBypass,
    K_ANONYMITY_THRESHOLD: 5,
  }));
  return (await import('@/components/admin/questionnaires/analytics/analytics-view')).AnalyticsView;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/questionnaire/analytics/privacy');
});

describe('AnalyticsView alpha privacy note', () => {
  it('shows the alpha disclosure note when the bypass is active', async () => {
    const AnalyticsView = await loadView(true);
    render(<AnalyticsView {...baseProps} />);
    expect(screen.getByRole('note')).toHaveTextContent(/disabled for alpha testing/i);
    expect(screen.getByRole('note')).toHaveTextContent(/fewer than 5 respondents/i);
  });

  it('renders no disclosure note when the bypass is off', async () => {
    const AnalyticsView = await loadView(false);
    render(<AnalyticsView {...baseProps} />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

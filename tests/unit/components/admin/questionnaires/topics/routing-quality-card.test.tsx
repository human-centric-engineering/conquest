// @vitest-environment happy-dom

/**
 * Unit tests: `RoutingQualityCard` — what routing actually did (F17.16).
 *
 * The card reports two failures that are invisible by nature: a criteria sentence that never fires,
 * and one respondents keep correcting. So the assertions are mostly about the card refusing to be
 * silent — it loads itself, it distinguishes "nothing happened yet" from "too few to show" from
 * "the read failed", and it never renders an empty table that reads as a clean bill of health.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({ apiClient: { get: vi.fn() } }));

import { RoutingQualityCard } from '@/components/admin/questionnaires/topics/routing-quality-card';
import { apiClient } from '@/lib/api/client';
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type {
  RoutingAnalyticsResult,
  RoutingTopicRow,
} from '@/lib/app/questionnaire/analytics/views';
import type { ScopeDecisionSource } from '@/lib/app/questionnaire/scope/types';

type Mock = ReturnType<typeof vi.fn>;

function row(key: string, overrides: Partial<RoutingTopicRow> = {}): RoutingTopicRow {
  return {
    key,
    label: `Topic ${key}`,
    phase: 'conditional',
    selected: 0,
    chosen: 0,
    sampled: 0,
    bySource: {} as Record<ScopeDecisionSource, number>,
    excluded: 0,
    droppedByBudget: 0,
    amended: 0,
    chosenRate: 0,
    ...overrides,
  };
}

function result(overrides: Partial<RoutingAnalyticsResult> = {}): RoutingAnalyticsResult {
  return {
    versionId: 'v1',
    range: { from: 'a', to: 'b' },
    plans: 10,
    amendedPlans: 0,
    fallbackPlans: 0,
    checkTopicPlans: 0,
    meanConfidence: 0.8,
    topics: [],
    findings: [],
    suppressed: false,
    truncated: false,
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof RoutingQualityCard>> = {}) {
  return render(
    <RoutingQualityCard
      questionnaireId="qn-1"
      versionId="ver-1"
      enabled
      conditionalCount={3}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  (apiClient.get as Mock).mockResolvedValue(result());
});

describe('RoutingQualityCard', () => {
  it('loads itself rather than waiting to be asked', async () => {
    renderCard();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
  });

  it('explains itself rather than vanishing when the feature is off', () => {
    renderCard({ enabled: false });

    // Same reason as the preview card: on a tab of its own, silence reads as a broken page. What
    // must NOT change is the fetch — there is no plan to report on, so it still asks for nothing.
    expect(screen.getByText(/No interviews to report on yet/i)).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('says the same when there is no conditional topic to decide about', () => {
    renderCard({ conditionalCount: 0 });

    expect(screen.getByText(/No interviews to report on yet/i)).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('separates "no interviews yet" from a clean bill of health', async () => {
    (apiClient.get as Mock).mockResolvedValue(result({ plans: 0 }));
    renderCard();
    expect(await screen.findByText(/No interview has reached a plan yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says how far a small cohort is from the threshold instead of showing an empty table', async () => {
    (apiClient.get as Mock).mockResolvedValue(result({ plans: 3, suppressed: true }));
    renderCard();

    const note = await screen.findByText(/Per-topic detail appears once/i);
    expect(note).toHaveTextContent(String(K_ANONYMITY_THRESHOLD));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('states a failed read rather than degrading to an empty result', async () => {
    // Silence is the thing this card exists to break, and "the fetch failed" must never render as
    // "nothing to report".
    (apiClient.get as Mock).mockRejectedValue(new Error('upstream exploded'));
    renderCard();

    expect(await screen.findByRole('alert')).toHaveTextContent('upstream exploded');
  });

  it('leads with the findings and shows the counts behind them', async () => {
    (apiClient.get as Mock).mockResolvedValue(
      result({
        plans: 12,
        topics: [
          row('growth', { selected: 9, chosen: 9, chosenRate: 0.75, excluded: 3, amended: 2 }),
        ],
        findings: [
          {
            code: 'respondents_keep_adding',
            topicKey: 'growth',
            message: 'Respondents asked for "Topic growth" themselves in 2 of 12 interviews.',
          },
        ],
      })
    );
    renderCard();

    expect(await screen.findByText(/Respondents asked for "Topic growth"/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('(75%)')).toBeInTheDocument();
  });

  it('shows a blind-spot sample in its own column, never folded into Chosen', async () => {
    // A topic sampled as the check is there BECAUSE nothing chose it; showing the two together
    // would render a dormant topic at 100%.
    (apiClient.get as Mock).mockResolvedValue(
      result({
        plans: 8,
        topics: [row('dormant', { selected: 8, chosen: 0, sampled: 8, chosenRate: 0 })],
      })
    );
    renderCard();

    const cells = (await screen.findByRole('table')).querySelectorAll('tbody td');
    expect(cells[1]).toHaveTextContent('0');
    expect(cells[1]).toHaveTextContent('(0%)');
    expect(cells[2]).toHaveTextContent('8');
  });

  it('says when the counts describe only the most recent plans', async () => {
    (apiClient.get as Mock).mockResolvedValue(result({ plans: 2000, truncated: true }));
    renderCard();

    expect(await screen.findByText(/most recent plans only/i)).toBeInTheDocument();
  });

  it('clears a stale error when the read is retried', async () => {
    // A failed read must not leave its alert beside a fresh table.
    (apiClient.get as Mock).mockRejectedValueOnce(new Error('upstream exploded'));
    const { rerender } = renderCard();
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    (apiClient.get as Mock).mockResolvedValue(result({ plans: 9 }));
    rerender(
      <RoutingQualityCard questionnaireId="qn-1" versionId="ver-2" enabled conditionalCount={3} />
    );

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('marks a topic that has since been deleted', async () => {
    (apiClient.get as Mock).mockResolvedValue(
      result({ topics: [row('gone', { label: 'gone', phase: null, selected: 4, chosen: 4 })] })
    );
    renderCard();

    expect(await screen.findByText('deleted')).toBeInTheDocument();
  });
});
